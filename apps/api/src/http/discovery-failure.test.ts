import { describe, expect, it, vi } from "vitest";
import { PrismaCoreApiRepository } from "./prisma-core-api-repository.js";

const JOB_ID = "00000000-0000-4000-8000-000000000901";
function harness(change: Record<string, unknown> = {}) {
  const task = { id: "task-id", status: "DISCOVERING", purchase: null,
    control: { discoveryJobId: JOB_ID, selectedService: null, approvedAt: null }, ...change };
  const tx = { $queryRaw: vi.fn(async () => []), task: { findUnique: vi.fn(async () => task), updateMany: vi.fn(async () => ({ count: 1 })) },
    auditEvent: { create: vi.fn(async () => ({})) } };
  const repository = new PrismaCoreApiRepository({ $transaction: (op: (transaction: typeof tx) => Promise<unknown>) => op(tx) } as never, {} as never);
  return { tx, fail: (jobId: string | undefined = JOB_ID) => repository.recordBackgroundFailure({
    operation: "DISCOVER_TASK", taskId: "task-id", jobId, requestId: "request-id", error: new Error("catalog unavailable"),
  }) };
}

describe("generation-bound discovery final failure", () => {
  it("makes an interrupted current discovery explicitly retryable without any purchase updates", async () => {
    const { tx, fail } = harness();
    await fail();
    expect(tx.task.updateMany).toHaveBeenCalledWith({ where: { id: "task-id", status: "DISCOVERING", control: { is: { discoveryJobId: JOB_ID } } },
      data: { status: "FAILED", errorCode: "INTERNAL_ERROR", errorMessage: "catalog unavailable" } });
    expect(tx.auditEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ eventType: "BACKGROUND_DISCOVER_TASK_FAILED_FINAL",
      payload: expect.objectContaining({ jobId: JOB_ID, paymentCreated: false }) }) });
  });

  it.each([
    { status: "WAITING_SELECTION" }, { status: "COMPLETED" }, { status: "FAILED" }, { status: "ACTION_REQUIRED" },
    { purchase: { id: "purchase-id" } }, { control: { discoveryJobId: JOB_ID, selectedService: { serviceId: "chosen" } } },
    { control: { discoveryJobId: JOB_ID, approvedAt: new Date() } }, { control: { discoveryJobId: "newer-job" } },
  ])("preserves newer or already completed progress after a late worker error: %j", async (change) => {
    const { tx, fail } = harness(change);
    await fail();
    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect(tx.auditEvent.create).not.toHaveBeenCalled();
  });

  it("does not modify a task without a job generation token", async () => {
    const { tx, fail } = harness();
    await fail("");
    expect(tx.task.findUnique).not.toHaveBeenCalled();
  });
});
