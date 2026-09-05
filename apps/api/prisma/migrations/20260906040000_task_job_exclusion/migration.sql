-- Enforce task dispatch exclusion even for older binaries and direct writes.
-- Existing overlapping operations deliberately make this migration fail: no
-- queued work is deleted or silently marked complete during deployment.
CREATE UNIQUE INDEX "WorkflowJob_active_task_dispatch_key"
ON "WorkflowJob" ("aggregateId")
WHERE "kind" IN ('RUN_TASK', 'DISCOVER_TASK')
  AND "status" IN ('PENDING', 'RUNNING', 'FAILED_RETRYABLE');
