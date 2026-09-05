-- Keep manually inserted/corrupt jobs from becoming poison queue entries that
-- no worker can dispatch, and ensure only RUNNING jobs may retain a lease.

ALTER TABLE "WorkflowJob"
ADD CONSTRAINT "WorkflowJob_kind_check"
CHECK ("kind" IN ('RUN_TASK', 'RETRY_INVOICE', 'RETRY_ANCHOR')),
ADD CONSTRAINT "WorkflowJob_running_lease_check"
CHECK (
  ("status" = 'RUNNING' AND "lockedAt" IS NOT NULL AND "lockedBy" IS NOT NULL)
  OR
  ("status" <> 'RUNNING' AND "lockedAt" IS NULL AND "lockedBy" IS NULL)
);
