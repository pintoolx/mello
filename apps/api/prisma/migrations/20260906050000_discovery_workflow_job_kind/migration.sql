-- Extend the existing allowlist without weakening any dispatch/attempt checks.
BEGIN;

ALTER TABLE "WorkflowJob"
DROP CONSTRAINT "WorkflowJob_kind_check";

ALTER TABLE "WorkflowJob"
ADD CONSTRAINT "WorkflowJob_kind_check"
CHECK ("kind" IN (
  'DISCOVER_TASK',
  'RUN_TASK',
  'RETRY_INVOICE',
  'RETRY_ANCHOR',
  'RECONCILE_PAYMENT'
));

COMMIT;
