import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { MelloError } from "@mello/shared";
import type { Logger } from "pino";
import type { BackgroundFailureInput, WorkflowOperations } from "../../http/contracts.js";
import type {
  ClaimedWorkflowJob,
  WorkflowJobPoller,
  WorkflowJobStore,
} from "./contracts.js";

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function objectString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || !(key in value)) return undefined;
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" ? property : undefined;
}

export function isRetryableWorkflowError(error: unknown): boolean {
  if (error instanceof MelloError) return error.retryable;
  const name = objectString(error, "name");
  if (name === "AbortError" || name === "TimeoutError") return true;
  const code = objectString(error, "code");
  if (code && RETRYABLE_NETWORK_CODES.has(code)) return true;
  // Native fetch reports transport failures as TypeError and preserves the
  // lower-level network error in `cause` on supported Node versions.
  if (error instanceof TypeError) return true;
  if (error && typeof error === "object" && "cause" in error) {
    return isRetryableWorkflowError((error as { cause?: unknown }).cause);
  }
  return false;
}

export interface WorkflowJobWorkerOptions {
  workerId?: string | undefined;
  pollIntervalMs?: number | undefined;
  leaseMs?: number | undefined;
  heartbeatIntervalMs?: number | undefined;
  backoffBaseMs?: number | undefined;
  clock?: (() => Date) | undefined;
  isRetrySafe?:
    | ((job: ClaimedWorkflowJob, error: unknown) => Promise<boolean>)
    | undefined;
}

export interface WorkflowJobWorkerDependencies {
  store: WorkflowJobStore;
  workflow: WorkflowOperations;
  logger: Logger;
  recordFinalFailure(input: BackgroundFailureInput): Promise<void>;
}

export class WorkflowJobWorker implements WorkflowJobPoller {
  private readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly backoffBaseMs: number;
  private readonly clock: () => Date;
  private readonly isRetrySafe: (
    job: ClaimedWorkflowJob,
    error: unknown,
  ) => Promise<boolean>;
  private active = false;
  private pollTimer: NodeJS.Timeout | undefined;
  private runningOnce: Promise<boolean> | undefined;

  constructor(
    private readonly dependencies: WorkflowJobWorkerDependencies,
    options: WorkflowJobWorkerOptions = {},
  ) {
    this.workerId =
      options.workerId ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? Math.max(1_000, Math.floor(this.leaseMs / 3));
    this.backoffBaseMs = options.backoffBaseMs ?? 1_000;
    this.clock = options.clock ?? (() => new Date());
    this.isRetrySafe = options.isRetrySafe ?? (async () => true);
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.schedulePoll(0);
  }

  async stop(): Promise<void> {
    this.active = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    await this.runningOnce;
  }

  runOnce(): Promise<boolean> {
    if (this.runningOnce) return this.runningOnce;
    const operation = this.runOnceInternal().finally(() => {
      if (this.runningOnce === operation) this.runningOnce = undefined;
    });
    this.runningOnce = operation;
    return operation;
  }

  private schedulePoll(delayMs: number): void {
    if (!this.active || this.pollTimer) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.poll();
    }, delayMs);
    this.pollTimer.unref();
  }

  private async poll(): Promise<void> {
    try {
      const processed = await this.runOnce();
      this.schedulePoll(processed ? 0 : this.pollIntervalMs);
    } catch (error: unknown) {
      this.dependencies.logger.error(
        { err: error, workerId: this.workerId, stage: "WORKFLOW_POLLER" },
        "Workflow poll failed",
      );
      this.schedulePoll(this.pollIntervalMs);
    }
  }

  private async runOnceInternal(): Promise<boolean> {
    const now = this.clock();
    const exhausted = await this.dependencies.store.finalizeExpiredExhausted({
      now,
      leaseMs: this.leaseMs,
    });
    for (const job of exhausted) {
      await this.recordFinalFailure(
        job,
        new MelloError(
          "INTERNAL_ERROR",
          "Worker lease expired after the final allowed attempt",
        ),
      );
    }

    const job = await this.dependencies.store.claimNext({
      workerId: this.workerId,
      now,
      leaseMs: this.leaseMs,
    });
    if (!job) return exhausted.length > 0;

    const heartbeat = this.startHeartbeat(job);
    try {
      await this.dispatch(job);
      const owned = await this.dependencies.store.markSucceeded({
        job,
        workerId: this.workerId,
        now: this.clock(),
      });
      if (!owned) {
        this.dependencies.logger.error(
          {
            jobId: job.id,
            workerId: this.workerId,
            operation: job.kind,
            stage: "WORKFLOW_JOB",
          },
          "Workflow job completed after its lease ownership was lost",
        );
      }
    } catch (error: unknown) {
      const retryable =
        isRetryableWorkflowError(error) && (await this.isRetrySafe(job, error));
      const failure = await this.dependencies.store.markFailed({
        job,
        workerId: this.workerId,
        now: this.clock(),
        retryable,
        error,
        backoffBaseMs: this.backoffBaseMs,
      });
      if (failure?.status === "FAILED_FINAL") {
        await this.recordFinalFailure(job, error);
      }
      this.dependencies.logger[retryable ? "warn" : "error"](
        {
          err: error,
          jobId: job.id,
          workerId: this.workerId,
          requestId: job.payload.requestId,
          taskId: job.payload.taskId,
          purchaseId: job.payload.purchaseId,
          operation: job.kind,
          attempt: job.attempts,
          maxAttempts: job.maxAttempts,
          jobStatus: failure?.status,
          stage: "WORKFLOW_JOB",
        },
        retryable ? "Workflow job will be retried" : "Workflow job failed permanently",
      );
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
    return true;
  }

  private startHeartbeat(job: ClaimedWorkflowJob): NodeJS.Timeout | undefined {
    if (this.heartbeatIntervalMs <= 0) return undefined;
    const timer = setInterval(() => {
      void this.dependencies.store
        .heartbeat({ jobId: job.id, workerId: this.workerId, now: this.clock() })
        .then((owned) => {
          if (!owned) {
            this.dependencies.logger.error(
              { jobId: job.id, workerId: this.workerId, stage: "WORKFLOW_JOB_HEARTBEAT" },
              "Workflow job lease ownership was lost",
            );
          }
        })
        .catch((error: unknown) => {
          this.dependencies.logger.error(
            {
              err: error,
              jobId: job.id,
              workerId: this.workerId,
              stage: "WORKFLOW_JOB_HEARTBEAT",
            },
            "Workflow job heartbeat failed",
          );
        });
    }, this.heartbeatIntervalMs);
    timer.unref();
    return timer;
  }

  private dispatch(job: ClaimedWorkflowJob): Promise<void> {
    switch (job.kind) {
      case "DISCOVER_TASK":
        return this.dependencies.workflow.discover(job.aggregateId, job.payload.requestId, job.id);
      case "RUN_TASK":
        return this.dependencies.workflow.run(job.aggregateId, job.payload.requestId);
      case "RETRY_INVOICE":
        return this.dependencies.workflow.retryInvoice(
          job.aggregateId,
          job.payload.requestId,
        );
      case "RETRY_ANCHOR":
        return this.dependencies.workflow.retryAnchor(
          job.aggregateId,
          job.payload.requestId,
        );
      case "RECONCILE_PAYMENT":
        return this.dependencies.workflow.reconcilePayment(
          job.aggregateId,
          job.payload.requestId,
        );
    }
  }

  private async recordFinalFailure(
    job: ClaimedWorkflowJob,
    error: unknown,
  ): Promise<void> {
    try {
      await this.dependencies.recordFinalFailure({
        operation: job.kind,
        ...(job.kind === "DISCOVER_TASK" ? { jobId: job.id } : {}),
        ...(job.payload.taskId ? { taskId: job.payload.taskId } : {}),
        ...(job.payload.purchaseId ? { purchaseId: job.payload.purchaseId } : {}),
        requestId: job.payload.requestId,
        error,
      });
    } catch (recordError: unknown) {
      this.dependencies.logger.error(
        {
          err: recordError,
          jobId: job.id,
          workerId: this.workerId,
          requestId: job.payload.requestId,
          stage: "WORKFLOW_JOB_FINAL_FAILURE",
        },
        "Could not persist aggregate state for a final workflow failure",
      );
    }
  }
}
