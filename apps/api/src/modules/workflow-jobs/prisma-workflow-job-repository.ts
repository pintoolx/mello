import { randomUUID } from "node:crypto";
import { MelloError, sanitizedErrorMessage } from "@mello/shared";
import { Prisma, type PrismaClient } from "@mello/db";
import type {
  ClaimedWorkflowJob,
  EnqueueWorkflowJobInput,
  WorkflowJobFailureResult,
  WorkflowJobKind,
  WorkflowJobPayload,
  WorkflowJobStore,
} from "./contracts.js";
import { acquireWorkflowQueueSharedLock } from "./queue-lock.js";

interface WorkflowJobRow {
  id: string;
  kind: string;
  aggregateId: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  availableAt: Date;
  lockedAt: Date;
  lockedBy: string;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const ACTIVE_JOB_STATUSES = ["PENDING", "RUNNING", "FAILED_RETRYABLE"] as const;
const MAX_ERROR_LENGTH = 2_000;
const MAX_BACKOFF_MS = 5 * 60_000;

function isWorkflowJobKind(value: string): value is WorkflowJobKind {
  return (
    value === "RUN_TASK" ||
    value === "RETRY_INVOICE" ||
    value === "RETRY_ANCHOR" ||
    value === "RECONCILE_PAYMENT"
  );
}

function payloadFrom(value: unknown): WorkflowJobPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Workflow job payload is not an object");
  }
  const payload = value as Record<string, unknown>;
  if (typeof payload["requestId"] !== "string") {
    throw new Error("Workflow job payload has no requestId");
  }
  return {
    requestId: payload["requestId"],
    ...(typeof payload["taskId"] === "string" ? { taskId: payload["taskId"] } : {}),
    ...(typeof payload["purchaseId"] === "string"
      ? { purchaseId: payload["purchaseId"] }
      : {}),
  };
}

function claimedJobFrom(row: WorkflowJobRow): ClaimedWorkflowJob {
  if (!isWorkflowJobKind(row.kind)) {
    throw new Error(`Unsupported workflow job kind: ${row.kind}`);
  }
  return {
    ...row,
    kind: row.kind,
    payload: payloadFrom(row.payload),
  };
}

function failureCode(error: unknown): string {
  return error instanceof MelloError ? error.code : "INTERNAL_ERROR";
}

function failureMessage(error: unknown): string {
  return sanitizedErrorMessage(error, "Unexpected workflow job error", MAX_ERROR_LENGTH);
}

function auditIdentity(job: {
  kind: WorkflowJobKind;
  aggregateId: string;
  payload: WorkflowJobPayload;
}): {
  aggregateType: "TASK" | "PURCHASE";
  aggregateId: string;
  taskId: string | null;
  purchaseId: string | null;
} {
  return {
    aggregateType: job.kind === "RUN_TASK" ? "TASK" : "PURCHASE",
    aggregateId: job.aggregateId,
    taskId: job.payload.taskId ?? null,
    purchaseId: job.payload.purchaseId ?? null,
  };
}

async function validateAggregateForEnqueue(
  transaction: Prisma.TransactionClient,
  input: EnqueueWorkflowJobInput,
): Promise<void> {
  if (input.kind === "RUN_TASK") {
    const task = await transaction.task.findUnique({
      where: { id: input.aggregateId },
      select: { status: true },
    });
    if (!task) {
      throw new MelloError("NOT_FOUND", "Task not found", { statusCode: 404 });
    }
    if (task.status !== "CREATED") {
      throw new MelloError("TASK_ALREADY_RUNNING", "Task cannot be queued from its current state", {
        statusCode: 409,
      });
    }
    return;
  }

  const purchase = await transaction.purchase.findUnique({
    where: { id: input.aggregateId },
    select: {
      invoice: { select: { status: true } },
      payment: { select: { status: true, transactionHash: true } },
      anchors: { select: { status: true } },
    },
  });
  if (!purchase) {
    throw new MelloError("NOT_FOUND", "Purchase not found", { statusCode: 404 });
  }
  if (input.kind === "RETRY_INVOICE" && purchase.invoice?.status !== "FAILED_RETRYABLE") {
    throw new MelloError("INVOICE_ISSUE_FAILED", "Invoice is not retryable", {
      statusCode: 409,
    });
  }
  if (
    input.kind === "RECONCILE_PAYMENT" &&
    (purchase.payment?.status !== "SETTLEMENT_PENDING" || !purchase.payment.transactionHash)
  ) {
    throw new MelloError("X402_PAYMENT_FAILED", "Payment has no pending settlement to reconcile", {
      statusCode: 409,
    });
  }
  if (
    input.kind === "RETRY_ANCHOR" &&
    !purchase.anchors.some(({ status }) => status === "FAILED_RETRYABLE")
  ) {
    throw new MelloError("CONTRACT_ANCHOR_FAILED", "No retryable anchor exists", {
      statusCode: 409,
    });
  }
}

export class PrismaWorkflowJobRepository implements WorkflowJobStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async enqueue(input: EnqueueWorkflowJobInput, existingTransaction?: Prisma.TransactionClient): Promise<{ id: string }> {
    const maxAttempts = input.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
      throw new RangeError("Workflow job maxAttempts must be between 1 and 3");
    }
    const id = randomUUID();
    const now = this.now();
    const enqueue = async (transaction: Prisma.TransactionClient) => {
      await acquireWorkflowQueueSharedLock(transaction);
      await validateAggregateForEnqueue(transaction, input);
      const inserted = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO "WorkflowJob" (
          "id", "kind", "aggregateId", "payload", "status", "attempts",
          "maxAttempts", "availableAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${id}::uuid,
          ${input.kind},
          ${input.aggregateId},
          ${JSON.stringify(input.payload)}::jsonb,
          'PENDING'::"WorkflowJobStatus",
          0,
          ${maxAttempts},
          ${now},
          ${now},
          ${now}
        )
        ON CONFLICT ("kind", "aggregateId")
          WHERE "status" IN ('PENDING', 'RUNNING', 'FAILED_RETRYABLE')
        DO NOTHING
        RETURNING "id"
      `);
      if (!inserted[0]) {
        throw new MelloError("TASK_ALREADY_RUNNING", "Workflow operation is already queued or running", {
          statusCode: 409,
        });
      }
      const identity = auditIdentity(input);
      await transaction.auditEvent.create({
        data: {
          ...identity,
          eventType: "WORKFLOW_JOB_ENQUEUED",
          actorType: "SYSTEM",
          payload: {
            jobId: id,
            kind: input.kind,
            maxAttempts,
          },
          requestId: input.payload.requestId,
          stage: "QUEUED",
        },
      });
      return { id };
    };
    return existingTransaction ? enqueue(existingTransaction) : this.prisma.$transaction(enqueue);
  }

  async hasActiveJobs(): Promise<boolean> {
    const count = await this.prisma.workflowJob.count({
      where: { status: { in: [...ACTIVE_JOB_STATUSES] } },
    });
    return count > 0;
  }

  async claimNext(input: {
    workerId: string;
    now: Date;
    leaseMs: number;
  }): Promise<ClaimedWorkflowJob | null> {
    const leaseCutoff = new Date(input.now.getTime() - input.leaseMs);
    const rows = await this.prisma.$transaction(async (transaction) => {
      await acquireWorkflowQueueSharedLock(transaction);
      return transaction.$queryRaw<WorkflowJobRow[]>(Prisma.sql`
        WITH candidate AS (
          SELECT "id"
          FROM "WorkflowJob"
          WHERE (
            "status" IN ('PENDING', 'FAILED_RETRYABLE')
            AND "availableAt" <= ${input.now}
            AND "attempts" < "maxAttempts"
          ) OR (
            "status" = 'RUNNING'
            AND "lockedAt" <= ${leaseCutoff}
            AND "attempts" < "maxAttempts"
          )
          ORDER BY
            CASE WHEN "status" = 'RUNNING' THEN 0 ELSE 1 END,
            "availableAt" ASC,
            "createdAt" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE "WorkflowJob" AS job
        SET
          "status" = 'RUNNING'::"WorkflowJobStatus",
          "attempts" = job."attempts" + 1,
          "lockedAt" = ${input.now},
          "lockedBy" = ${input.workerId},
          "updatedAt" = ${input.now}
        FROM candidate
        WHERE job."id" = candidate."id"
        RETURNING
          job."id", job."kind", job."aggregateId", job."payload",
          job."attempts", job."maxAttempts", job."availableAt",
          job."lockedAt", job."lockedBy", job."lastError",
          job."createdAt", job."updatedAt"
      `);
    });
    return rows[0] ? claimedJobFrom(rows[0]) : null;
  }

  async heartbeat(input: {
    jobId: string;
    workerId: string;
    now: Date;
  }): Promise<boolean> {
    const result = await this.prisma.workflowJob.updateMany({
      where: { id: input.jobId, status: "RUNNING", lockedBy: input.workerId },
      data: { lockedAt: input.now },
    });
    return result.count === 1;
  }

  async markSucceeded(input: {
    job: ClaimedWorkflowJob;
    workerId: string;
    now: Date;
  }): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const result = await transaction.workflowJob.updateMany({
        where: { id: input.job.id, status: "RUNNING", lockedBy: input.workerId },
        data: {
          status: "SUCCEEDED",
          lockedAt: null,
          lockedBy: null,
          lastError: null,
          availableAt: input.now,
        },
      });
      if (result.count !== 1) return false;
      const identity = auditIdentity(input.job);
      await transaction.auditEvent.create({
        data: {
          ...identity,
          eventType: "WORKFLOW_JOB_SUCCEEDED",
          actorType: "SYSTEM",
          payload: {
            jobId: input.job.id,
            kind: input.job.kind,
            attempts: input.job.attempts,
          },
          requestId: input.job.payload.requestId,
          stage: "WORKFLOW_JOB",
        },
      });
      return true;
    });
  }

  async markFailed(input: {
    job: ClaimedWorkflowJob;
    workerId: string;
    now: Date;
    retryable: boolean;
    error: unknown;
    backoffBaseMs: number;
  }): Promise<WorkflowJobFailureResult | null> {
    const canRetry = input.retryable && input.job.attempts < input.job.maxAttempts;
    const delayMs = canRetry
      ? Math.min(
          input.backoffBaseMs * 2 ** Math.max(0, input.job.attempts - 1),
          MAX_BACKOFF_MS,
        )
      : 0;
    const availableAt = new Date(input.now.getTime() + delayMs);
    const status = canRetry ? "FAILED_RETRYABLE" : "FAILED_FINAL";
    const message = failureMessage(input.error);
    return this.prisma.$transaction(async (transaction) => {
      const result = await transaction.workflowJob.updateMany({
        where: { id: input.job.id, status: "RUNNING", lockedBy: input.workerId },
        data: {
          status,
          lockedAt: null,
          lockedBy: null,
          lastError: message,
          availableAt,
        },
      });
      if (result.count !== 1) return null;
      const identity = auditIdentity(input.job);
      await transaction.auditEvent.create({
        data: {
          ...identity,
          eventType: canRetry
            ? "WORKFLOW_JOB_RETRY_SCHEDULED"
            : "WORKFLOW_JOB_FAILED_FINAL",
          actorType: "SYSTEM",
          payload: {
            jobId: input.job.id,
            kind: input.job.kind,
            attempt: input.job.attempts,
            maxAttempts: input.job.maxAttempts,
            errorCode: failureCode(input.error),
            retryable: canRetry,
            ...(canRetry ? { nextAttemptAt: availableAt.toISOString() } : {}),
          },
          requestId: input.job.payload.requestId,
          stage: canRetry ? "RETRY_SCHEDULED" : "FAILED_FINAL",
        },
      });
      return { status, availableAt };
    });
  }

  async finalizeExpiredExhausted(input: {
    now: Date;
    leaseMs: number;
  }): Promise<ClaimedWorkflowJob[]> {
    const leaseCutoff = new Date(input.now.getTime() - input.leaseMs);
    return this.prisma.$transaction(async (transaction) => {
      await acquireWorkflowQueueSharedLock(transaction);
      const rows = await transaction.$queryRaw<WorkflowJobRow[]>(Prisma.sql`
        UPDATE "WorkflowJob"
        SET
          "status" = 'FAILED_FINAL'::"WorkflowJobStatus",
          "lockedAt" = NULL,
          "lockedBy" = NULL,
          "lastError" = 'Worker lease expired after the final allowed attempt',
          "availableAt" = ${input.now},
          "updatedAt" = ${input.now}
        WHERE
          "status" = 'RUNNING'
          AND "lockedAt" <= ${leaseCutoff}
          AND "attempts" >= "maxAttempts"
        RETURNING
          "id", "kind", "aggregateId", "payload", "attempts",
          "maxAttempts", "availableAt", ${input.now} AS "lockedAt",
          'expired-worker'::text AS "lockedBy", "lastError", "createdAt", "updatedAt"
      `);
      const jobs = rows.map(claimedJobFrom);
      for (const job of jobs) {
        const identity = auditIdentity(job);
        await transaction.auditEvent.create({
          data: {
            ...identity,
            eventType: "WORKFLOW_JOB_FAILED_FINAL",
            actorType: "SYSTEM",
            payload: {
              jobId: job.id,
              kind: job.kind,
              attempt: job.attempts,
              maxAttempts: job.maxAttempts,
              errorCode: "WORKER_LEASE_EXPIRED",
              retryable: false,
            },
            requestId: job.payload.requestId,
            stage: "FAILED_FINAL",
          },
        });
      }
      return jobs;
    });
  }
}
