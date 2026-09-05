import { randomUUID } from "node:crypto";
import { prisma } from "@mello/db";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const RUN_INTEGRATION_TESTS = process.env["RUN_INTEGRATION_TESTS"] === "true";
const aggregateIds: string[] = [];

async function cleanup(): Promise<void> {
  if (aggregateIds.length === 0) return;
  await prisma.auditEvent.deleteMany({ where: { aggregateId: { in: aggregateIds } } });
  aggregateIds.splice(0, aggregateIds.length);
}

describe.skipIf(!RUN_INTEGRATION_TESTS).sequential("audit event PostgreSQL ordering", () => {
  afterEach(cleanup);
  afterAll(async () => prisma.$disconnect());

  it("assigns a unique monotonic order when event timestamps are identical", async () => {
    const aggregateId = randomUUID();
    aggregateIds.push(aggregateId);
    const createdAt = new Date("2030-01-01T00:00:00.000Z");

    const [first, second] = await prisma.$transaction(async (transaction) => {
      const firstEvent = await transaction.auditEvent.create({
        data: {
          aggregateType: "TASK",
          aggregateId,
          eventType: "FIRST",
          actorType: "SYSTEM",
          payload: {},
          createdAt,
        },
      });
      const secondEvent = await transaction.auditEvent.create({
        data: {
          aggregateType: "TASK",
          aggregateId,
          eventType: "SECOND",
          actorType: "SYSTEM",
          payload: {},
          createdAt,
        },
      });
      return [firstEvent, secondEvent];
    });

    expect(second.sequence).toBeGreaterThan(first.sequence);
    const ordered = await prisma.auditEvent.findMany({
      where: { aggregateId },
      orderBy: { sequence: "asc" },
      select: { eventType: true, sequence: true, createdAt: true },
    });
    expect(ordered.map(({ eventType }) => eventType)).toEqual(["FIRST", "SECOND"]);
    expect(ordered[0]?.createdAt).toEqual(ordered[1]?.createdAt);
  });
});
