import type { PrismaClient } from "@mello/db";
import { describe, expect, it, vi } from "vitest";
import type { ClaimedWorkflowJob } from "./contracts.js";
import { PrismaWorkflowJobRepository } from "./prisma-workflow-job-repository.js";

const NOW = new Date("2026-09-04T12:00:00.000Z");

function claimedJob(attempts = 2, maxAttempts = 3): ClaimedWorkflowJob {
  return {
    id: "00000000-0000-4000-8000-000000000103",
    kind: "RETRY_INVOICE",
    aggregateId: "00000000-0000-4000-8000-000000000102",
    payload: {
      requestId: "request-1",
      taskId: "00000000-0000-4000-8000-000000000101",
      purchaseId: "00000000-0000-4000-8000-000000000102",
    },
    attempts,
    maxAttempts,
    availableAt: NOW,
    lockedAt: NOW,
    lockedBy: "worker-1",
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("PrismaWorkflowJobRepository", () => {
  it("rejects a queue request above the three-attempt network ceiling", async () => {
    const repository = new PrismaWorkflowJobRepository({} as PrismaClient);

    await expect(
      repository.enqueue({
        kind: "RUN_TASK",
        aggregateId: "00000000-0000-4000-8000-000000000101",
        payload: { requestId: "attempt-cap" },
        maxAttempts: 4,
      }),
    ).rejects.toThrow("between 1 and 3");
  });

  it("uses exponential backoff and atomically writes retry audit metadata", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const auditCreate = vi.fn(async () => ({ id: "event-1" }));
    const transaction = {
      workflowJob: { updateMany },
      auditEvent: { create: auditCreate },
    };
    const prisma = {
      $transaction: vi.fn(
        async (operation: (client: typeof transaction) => Promise<unknown>) =>
          operation(transaction),
      ),
    } as unknown as PrismaClient;
    const repository = new PrismaWorkflowJobRepository(prisma);
    const job = claimedJob(2, 3);

    const result = await repository.markFailed({
      job,
      workerId: "worker-1",
      now: NOW,
      retryable: true,
      error: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
      backoffBaseMs: 1_000,
    });

    expect(result).toEqual({
      status: "FAILED_RETRYABLE",
      availableAt: new Date(NOW.getTime() + 2_000),
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "RUNNING", lockedBy: "worker-1" }),
        data: expect.objectContaining({
          status: "FAILED_RETRYABLE",
          lockedAt: null,
          lockedBy: null,
          availableAt: new Date(NOW.getTime() + 2_000),
        }),
      }),
    );
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventType: "WORKFLOW_JOB_RETRY_SCHEDULED" }),
    });
  });

  it("releases the active-operation key by moving the final attempt to FAILED_FINAL", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const auditCreate = vi.fn(async () => ({ id: "event-1" }));
    const transaction = {
      workflowJob: { updateMany },
      auditEvent: { create: auditCreate },
    };
    const prisma = {
      $transaction: vi.fn(
        async (operation: (client: typeof transaction) => Promise<unknown>) =>
          operation(transaction),
      ),
    } as unknown as PrismaClient;
    const repository = new PrismaWorkflowJobRepository(prisma);

    const result = await repository.markFailed({
      job: claimedJob(3, 3),
      workerId: "worker-1",
      now: NOW,
      retryable: true,
      error: new TypeError("fetch failed"),
      backoffBaseMs: 1_000,
    });

    expect(result?.status).toBe("FAILED_FINAL");
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED_FINAL" }) }),
    );
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventType: "WORKFLOW_JOB_FAILED_FINAL" }),
    });
  });

  it("redacts credentials before persisting a workflow job error", async () => {
    const updateMany = vi.fn(async (input: unknown) => {
      void input;
      return { count: 1 };
    });
    const transaction = {
      workflowJob: { updateMany },
      auditEvent: { create: vi.fn(async () => ({ id: "event-1" })) },
    };
    const prisma = {
      $transaction: vi.fn(
        async (operation: (client: typeof transaction) => Promise<unknown>) =>
          operation(transaction),
      ),
    } as unknown as PrismaClient;
    const repository = new PrismaWorkflowJobRepository(prisma);

    await repository.markFailed({
      job: claimedJob(),
      workerId: "worker-1",
      now: NOW,
      retryable: true,
      error: new Error(
        "upstream https://mainnet.infura.io/v3/INFURA_SENTINEL " +
          "Bearer BEARER_SENTINEL",
      ),
      backoffBaseMs: 1_000,
    });

    const update = updateMany.mock.calls[0]?.[0] as
      | { data: { lastError: string } }
      | undefined;
    const persisted = update?.data.lastError ?? "";
    expect(persisted).toContain("[REDACTED]");
    expect(persisted).not.toContain("INFURA_SENTINEL");
    expect(persisted).not.toContain("BEARER_SENTINEL");
  });
});
