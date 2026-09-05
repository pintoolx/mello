-- D-09 durable workflow queue invariants.
--
-- A partial unique index provides an atomic, database-enforced idempotency gate
-- while still retaining terminal job history. The two partial claim indexes
-- keep the hot queue and expired-lease scans small as history accumulates.

CREATE UNIQUE INDEX "WorkflowJob_active_operation_key"
ON "WorkflowJob"("kind", "aggregateId")
WHERE "status" IN ('PENDING', 'RUNNING', 'FAILED_RETRYABLE');

CREATE INDEX "WorkflowJob_ready_claim_idx"
ON "WorkflowJob"("availableAt", "createdAt")
WHERE "status" IN ('PENDING', 'FAILED_RETRYABLE');

CREATE INDEX "WorkflowJob_expired_lease_idx"
ON "WorkflowJob"("lockedAt", "createdAt")
WHERE "status" = 'RUNNING';

ALTER TABLE "WorkflowJob"
ADD CONSTRAINT "WorkflowJob_attempts_nonnegative_check"
CHECK ("attempts" >= 0),
ADD CONSTRAINT "WorkflowJob_maxAttempts_positive_check"
CHECK ("maxAttempts" BETWEEN 1 AND 20),
ADD CONSTRAINT "WorkflowJob_lock_pair_check"
CHECK (("lockedAt" IS NULL) = ("lockedBy" IS NULL));
