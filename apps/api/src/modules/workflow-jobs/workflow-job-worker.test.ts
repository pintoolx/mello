import { MelloError } from "@mello/shared";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowOperations } from "../../http/contracts.js";
import type {
  ClaimedWorkflowJob,
  WorkflowJobStore,
} from "./contracts.js";
import {
  isRetryableWorkflowError,
  WorkflowJobWorker,
} from "./workflow-job-worker.js";

const NOW = new Date("2026-09-04T12:00:00.000Z");

function job(
  kind: ClaimedWorkflowJob["kind"] = "RUN_TASK",
  attempts = 1,
): ClaimedWorkflowJob {
  const aggregateId =
    kind === "RUN_TASK" || kind === "DISCOVER_TASK"
      ? "00000000-0000-4000-8000-000000000101"
      : "00000000-0000-4000-8000-000000000102";
  return {
    id: "00000000-0000-4000-8000-000000000103",
    kind,
    aggregateId,
    payload: {
      requestId: "request-job-1",
      taskId: "00000000-0000-4000-8000-000000000101",
      ...(kind === "RUN_TASK" || kind === "DISCOVER_TASK" ? {} : { purchaseId: aggregateId }),
    },
    attempts,
    maxAttempts: 3,
    availableAt: NOW,
    lockedAt: NOW,
    lockedBy: "test-worker",
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function store(claimed: ClaimedWorkflowJob | null): WorkflowJobStore {
  return {
    enqueue: vi.fn(async () => ({ id: "job-1" })),
    hasActiveJobs: vi.fn(async () => claimed !== null),
    claimNext: vi.fn(async () => claimed),
    heartbeat: vi.fn(async () => true),
    markSucceeded: vi.fn(async () => true),
    markFailed: vi.fn(
      async (input: Parameters<WorkflowJobStore["markFailed"]>[0]) =>
        input.retryable
          ? ({ status: "FAILED_RETRYABLE", availableAt: NOW } as const)
          : ({ status: "FAILED_FINAL", availableAt: NOW } as const),
    ),
    finalizeExpiredExhausted: vi.fn(async () => []),
  };
}

function workflow(): WorkflowOperations {
  return {
    discover: vi.fn(async () => undefined),
    run: vi.fn(async () => undefined),
    retryInvoice: vi.fn(async () => undefined),
    retryAnchor: vi.fn(async () => undefined),
    reconcilePayment: vi.fn(async () => undefined),
  };
}

function logger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function worker(
  workflowJob: ClaimedWorkflowJob | null,
  operations = workflow(),
  overrides: {
    store?: WorkflowJobStore | undefined;
    retrySafe?: boolean | undefined;
  } = {},
) {
  const workflowStore = overrides.store ?? store(workflowJob);
  const recordFinalFailure = vi.fn(async () => undefined);
  return {
    workflowStore,
    operations,
    recordFinalFailure,
    instance: new WorkflowJobWorker(
      {
        store: workflowStore,
        workflow: operations,
        logger: logger(),
        recordFinalFailure,
      },
      {
        workerId: "test-worker",
        heartbeatIntervalMs: 0,
        clock: () => NOW,
        isRetrySafe: async () => overrides.retrySafe ?? true,
      },
    ),
  };
}

describe("WorkflowJobWorker", () => {
  it("dispatches discovery only to the generation-bound read-only workflow, never run", async () => {
    const claimed = job("DISCOVER_TASK");
    const runtime = worker(claimed);
    await expect(runtime.instance.runOnce()).resolves.toBe(true);
    expect(runtime.operations.discover).toHaveBeenCalledExactlyOnceWith(claimed.aggregateId, claimed.payload.requestId, claimed.id);
    expect(runtime.operations.run).not.toHaveBeenCalled();
    expect(runtime.operations.retryInvoice).not.toHaveBeenCalled();
    expect(runtime.operations.retryAnchor).not.toHaveBeenCalled();
    expect(runtime.workflowStore.markSucceeded).toHaveBeenCalledOnce();
  });

  it("binds discovery final errors to their exact durable job generation", async () => {
    const claimed = job("DISCOVER_TASK");
    const operations = workflow();
    vi.mocked(operations.discover).mockRejectedValue(new Error("catalog unavailable"));
    const runtime = worker(claimed, operations);
    await runtime.instance.runOnce();
    expect(runtime.recordFinalFailure).toHaveBeenCalledWith(expect.objectContaining({ operation: "DISCOVER_TASK", jobId: claimed.id, taskId: claimed.aggregateId }));
    expect(runtime.operations.run).not.toHaveBeenCalled();
  });
  it.each([
    ["RUN_TASK", "run"],
    ["RETRY_INVOICE", "retryInvoice"],
    ["RETRY_ANCHOR", "retryAnchor"],
    ["RECONCILE_PAYMENT", "reconcilePayment"],
  ] as const)("dispatches %s and marks it succeeded", async (kind, method) => {
    const claimed = job(kind);
    const runtime = worker(claimed);

    await expect(runtime.instance.runOnce()).resolves.toBe(true);

    expect(runtime.operations[method]).toHaveBeenCalledWith(
      claimed.aggregateId,
      claimed.payload.requestId,
    );
    expect(runtime.workflowStore.markSucceeded).toHaveBeenCalledWith({
      job: claimed,
      workerId: "test-worker",
      now: NOW,
    });
    expect(runtime.recordFinalFailure).not.toHaveBeenCalled();
  });

  it("schedules a safe network failure for retry without finalizing the aggregate", async () => {
    const claimed = job("RETRY_INVOICE");
    const operations = workflow();
    vi.mocked(operations.retryInvoice).mockRejectedValue(
      Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
    );
    const runtime = worker(claimed, operations);

    await runtime.instance.runOnce();

    expect(runtime.workflowStore.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ retryable: true, job: claimed, backoffBaseMs: 1_000 }),
    );
    expect(runtime.recordFinalFailure).not.toHaveBeenCalled();
  });

  it("finalizes an unsafe retry instead of re-entering a non-resumable workflow", async () => {
    const claimed = job();
    const operations = workflow();
    vi.mocked(operations.run).mockRejectedValue(new TypeError("fetch failed"));
    const runtime = worker(claimed, operations, { retrySafe: false });

    await runtime.instance.runOnce();

    expect(runtime.workflowStore.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ retryable: false }),
    );
    expect(runtime.recordFinalFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "RUN_TASK",
        taskId: claimed.payload.taskId,
        error: expect.any(TypeError),
      }),
    );
  });

  it("fails a reclaimed RUN_TASK closed when persisted state refuses crash re-entry", async () => {
    const reclaimed = job("RUN_TASK", 2);
    const operations = workflow();
    vi.mocked(operations.run).mockRejectedValue(
      new MelloError("TASK_ALREADY_RUNNING", "Task advanced before worker crash", {
        statusCode: 409,
      }),
    );
    const runtime = worker(reclaimed, operations);

    await runtime.instance.runOnce();

    expect(operations.run).toHaveBeenCalledOnce();
    expect(runtime.workflowStore.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ job: reclaimed, retryable: false }),
    );
    expect(runtime.recordFinalFailure).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "RUN_TASK", error: expect.any(MelloError) }),
    );
  });

  it("finalizes exhausted crashed leases before claiming fresh work", async () => {
    const exhausted = job("RETRY_ANCHOR", 3);
    const workflowStore = store(null);
    vi.mocked(workflowStore.finalizeExpiredExhausted).mockResolvedValue([exhausted]);
    const runtime = worker(null, workflow(), { store: workflowStore });

    await expect(runtime.instance.runOnce()).resolves.toBe(true);

    expect(runtime.recordFinalFailure).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "RETRY_ANCHOR" }),
    );
    expect(workflowStore.claimNext).toHaveBeenCalledOnce();
  });

  it("classifies explicit and transport failures without retrying ordinary errors", () => {
    expect(
      isRetryableWorkflowError(
        new MelloError("X402_PAYMENT_FAILED", "facilitator unavailable", {
          retryable: true,
        }),
      ),
    ).toBe(true);
    expect(
      isRetryableWorkflowError(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })),
    ).toBe(true);
    expect(isRetryableWorkflowError(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryableWorkflowError(new Error("invalid workflow state"))).toBe(false);
  });

  it("stops polling without leaving a timer that can claim later work", async () => {
    vi.useFakeTimers();
    try {
      const runtime = worker(null);
      runtime.instance.start();
      await vi.advanceTimersByTimeAsync(0);
      const claimsBeforeStop = vi.mocked(runtime.workflowStore.claimNext).mock.calls.length;

      await runtime.instance.stop();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(runtime.workflowStore.claimNext).toHaveBeenCalledTimes(claimsBeforeStop);
    } finally {
      vi.useRealTimers();
    }
  });
});
