import { randomUUID } from "node:crypto";
import { prisma } from "@mello/db";
import { MelloError } from "@mello/shared";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { PrismaWorkflowJobRepository } from "./prisma-workflow-job-repository.js";

const RUN_INTEGRATION_TESTS =
  process.env["RUN_WORKFLOW_JOB_INTEGRATION_TESTS"] === "true" ||
  process.env["RUN_INTEGRATION_TESTS"] === "true";

// Keep test jobs invisible to a separately running local Core worker. The
// repository under test advances its own explicit clock when it claims them.
const ENQUEUE_AT = new Date("2035-01-01T00:00:00.000Z");
const createdTaskIds: string[] = [];
const repository = new PrismaWorkflowJobRepository(prisma, () => ENQUEUE_AT);

function testNow(offsetMs = 1_000): Date {
  return new Date(ENQUEUE_AT.getTime() + offsetMs);
}

async function createTask(): Promise<string> {
  const id = randomUUID();
  await prisma.task.create({ data: { id, prompt: `durable queue test ${id}` } });
  createdTaskIds.push(id);
  return id;
}

async function cleanup(): Promise<void> {
  if (createdTaskIds.length === 0) return;
  await prisma.workflowJob.deleteMany({ where: { aggregateId: { in: createdTaskIds } } });
  await prisma.auditEvent.deleteMany({ where: { taskId: { in: createdTaskIds } } });
  await prisma.task.deleteMany({ where: { id: { in: createdTaskIds } } });
  createdTaskIds.splice(0, createdTaskIds.length);
}

describe.skipIf(!RUN_INTEGRATION_TESTS).sequential(
  "PrismaWorkflowJobRepository PostgreSQL queue",
  () => {
    afterAll(async () => {
      await prisma.$disconnect();
    });
    afterEach(cleanup);

    it("atomically rejects duplicate active operations and releases the key at terminal state", async () => {
      const taskId = await createTask();
      const enqueue = () =>
        repository.enqueue({
          kind: "RUN_TASK",
          aggregateId: taskId,
          payload: { taskId, requestId: randomUUID() },
          maxAttempts: 3,
        });

      const results = await Promise.allSettled([enqueue(), enqueue()]);
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      const rejected = results.find(({ status }) => status === "rejected");
      expect(rejected?.status).toBe("rejected");
      if (!rejected || rejected.status !== "rejected") {
        throw new Error("Expected one duplicate enqueue to fail");
      }
      expect(rejected.reason).toBeInstanceOf(MelloError);
      expect(rejected.reason).toMatchObject({
        code: "TASK_ALREADY_RUNNING",
        statusCode: 409,
      });

      const now = testNow();
      const claimed = await repository.claimNext({
        workerId: "terminal-worker",
        now,
        leaseMs: 1_000,
      });
      expect(claimed).toMatchObject({ aggregateId: taskId, attempts: 1 });
      if (!claimed) throw new Error("Expected queued job to be claimed");
      await repository.markSucceeded({ job: claimed, workerId: "terminal-worker", now });

      await expect(enqueue()).resolves.toEqual({ id: expect.any(String) });
    });

    it("uses SKIP LOCKED so concurrent workers claim distinct ready jobs", async () => {
      const firstTaskId = await createTask();
      const secondTaskId = await createTask();
      for (const taskId of [firstTaskId, secondTaskId]) {
        await repository.enqueue({
          kind: "RUN_TASK",
          aggregateId: taskId,
          payload: { taskId, requestId: randomUUID() },
        });
      }
      const now = testNow();

      const [first, second] = await Promise.all([
        repository.claimNext({ workerId: "worker-a", now, leaseMs: 1_000 }),
        repository.claimNext({ workerId: "worker-b", now, leaseMs: 1_000 }),
      ]);

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(new Set([first?.id, second?.id]).size).toBe(2);
      expect(new Set([first?.aggregateId, second?.aggregateId])).toEqual(
        new Set([firstTaskId, secondTaskId]),
      );
    });

    it("reclaims a crashed worker only after lease expiry and consumes the next attempt", async () => {
      const taskId = await createTask();
      await repository.enqueue({
        kind: "RUN_TASK",
        aggregateId: taskId,
        payload: { taskId, requestId: randomUUID() },
        maxAttempts: 2,
      });
      const firstAttemptAt = testNow();
      const first = await repository.claimNext({
        workerId: "crashed-worker",
        now: firstAttemptAt,
        leaseMs: 1_000,
      });
      expect(first).toMatchObject({ aggregateId: taskId, attempts: 1 });

      await expect(
        repository.claimNext({
          workerId: "early-worker",
          now: new Date(firstAttemptAt.getTime() + 999),
          leaseMs: 1_000,
        }),
      ).resolves.toBeNull();

      const reclaimed = await repository.claimNext({
        workerId: "recovery-worker",
        now: new Date(firstAttemptAt.getTime() + 1_001),
        leaseMs: 1_000,
      });
      expect(reclaimed).toMatchObject({
        id: first?.id,
        aggregateId: taskId,
        attempts: 2,
        lockedBy: "recovery-worker",
      });
    });

    it("finalizes a crashed lease that already used its last attempt", async () => {
      const taskId = await createTask();
      await repository.enqueue({
        kind: "RUN_TASK",
        aggregateId: taskId,
        payload: { taskId, requestId: randomUUID() },
        maxAttempts: 1,
      });
      const claimedAt = testNow();
      const claimed = await repository.claimNext({
        workerId: "last-attempt-worker",
        now: claimedAt,
        leaseMs: 1_000,
      });
      expect(claimed?.attempts).toBe(1);
      if (!claimed) throw new Error("Expected last-attempt job to be claimed");

      const finalized = await repository.finalizeExpiredExhausted({
        now: new Date(claimedAt.getTime() + 1_001),
        leaseMs: 1_000,
      });
      expect(finalized).toHaveLength(1);
      expect(finalized[0]).toMatchObject({ id: claimed.id, aggregateId: taskId });
      await expect(
        prisma.workflowJob.findUnique({ where: { id: claimed.id } }),
      ).resolves.toMatchObject({ status: "FAILED_FINAL", lockedAt: null, lockedBy: null });
      await expect(
        prisma.auditEvent.findFirst({
          where: {
            taskId,
            eventType: "WORKFLOW_JOB_FAILED_FINAL",
          },
        }),
      ).resolves.not.toBeNull();
    });
  },
);
