-- RECONCILE_PAYMENT is a first-class durable recovery operation and must pass
-- the same database boundary that rejects undispatchable workflow job kinds.

ALTER TABLE "WorkflowJob"
DROP CONSTRAINT IF EXISTS "WorkflowJob_kind_check";

ALTER TABLE "WorkflowJob"
ADD CONSTRAINT "WorkflowJob_kind_check"
CHECK (
  "kind" IN (
    'RUN_TASK',
    'RETRY_INVOICE',
    'RETRY_ANCHOR',
    'RECONCILE_PAYMENT'
  )
);
