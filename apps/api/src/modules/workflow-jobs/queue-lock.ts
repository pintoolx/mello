import type { Prisma } from "@mello/db";

// Stable, application-specific bigint used only for transaction-scoped advisory
// locking. Shared locks cover enqueue/claim; demo reset takes the exclusive lock.
export const WORKFLOW_QUEUE_ADVISORY_LOCK = 557_074_766_908_245n;

export async function acquireWorkflowQueueSharedLock(
  transaction: Prisma.TransactionClient,
): Promise<void> {
  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock_shared(${WORKFLOW_QUEUE_ADVISORY_LOCK}) IS NULL AS "acquired"
  `;
}

export async function acquireWorkflowQueueExclusiveLock(
  transaction: Prisma.TransactionClient,
): Promise<void> {
  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(${WORKFLOW_QUEUE_ADVISORY_LOCK}) IS NULL AS "acquired"
  `;
}
