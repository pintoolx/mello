import type { Prisma } from "@mello/db";

export const WORKFLOW_JOB_KINDS = [
  "DISCOVER_TASK",
  "RUN_TASK",
  "RETRY_INVOICE",
  "RETRY_ANCHOR",
  "RECONCILE_PAYMENT",
] as const;

export type WorkflowJobKind = (typeof WORKFLOW_JOB_KINDS)[number];

export interface WorkflowJobPayload {
  requestId: string;
  taskId?: string | undefined;
  purchaseId?: string | undefined;
}

export interface EnqueueWorkflowJobInput {
  kind: WorkflowJobKind;
  aggregateId: string;
  payload: WorkflowJobPayload;
  maxAttempts?: number | undefined;
}

export interface ClaimedWorkflowJob {
  id: string;
  kind: WorkflowJobKind;
  aggregateId: string;
  payload: WorkflowJobPayload;
  attempts: number;
  maxAttempts: number;
  availableAt: Date;
  lockedAt: Date;
  lockedBy: string;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowJobFailureResult {
  status: "FAILED_RETRYABLE" | "FAILED_FINAL";
  availableAt: Date;
}

export interface WorkflowJobQueue {
  enqueue(input: EnqueueWorkflowJobInput, transaction?: Prisma.TransactionClient): Promise<{ id: string }>;
  hasActiveJobs(): Promise<boolean>;
}

export interface WorkflowJobStore extends WorkflowJobQueue {
  claimNext(input: {
    workerId: string;
    now: Date;
    leaseMs: number;
  }): Promise<ClaimedWorkflowJob | null>;
  heartbeat(input: {
    jobId: string;
    workerId: string;
    now: Date;
  }): Promise<boolean>;
  markSucceeded(input: {
    job: ClaimedWorkflowJob;
    workerId: string;
    now: Date;
  }): Promise<boolean>;
  markFailed(input: {
    job: ClaimedWorkflowJob;
    workerId: string;
    now: Date;
    retryable: boolean;
    error: unknown;
    backoffBaseMs: number;
  }): Promise<WorkflowJobFailureResult | null>;
  finalizeExpiredExhausted(input: {
    now: Date;
    leaseMs: number;
  }): Promise<ClaimedWorkflowJob[]>;
}

export interface WorkflowJobPoller {
  start(): void;
  stop(): Promise<void>;
  runOnce(): Promise<boolean>;
}
