-- Audit timestamps have millisecond precision and can tie within one workflow
-- transaction. Backfill deterministically, then let PostgreSQL assign all new
-- events from the same monotonic sequence.
CREATE SEQUENCE "AuditEvent_sequence_seq";

ALTER TABLE "AuditEvent" ADD COLUMN "sequence" BIGINT;

WITH ordered_events AS (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt" ASC, "id" ASC) AS "sequence"
  FROM "AuditEvent"
)
UPDATE "AuditEvent" AS event
SET "sequence" = ordered_events."sequence"
FROM ordered_events
WHERE event."id" = ordered_events."id";

SELECT setval(
  '"AuditEvent_sequence_seq"',
  COALESCE((SELECT MAX("sequence") FROM "AuditEvent"), 0) + 1,
  false
);

ALTER TABLE "AuditEvent"
ALTER COLUMN "sequence" SET DEFAULT nextval('"AuditEvent_sequence_seq"'),
ALTER COLUMN "sequence" SET NOT NULL;

ALTER SEQUENCE "AuditEvent_sequence_seq" OWNED BY "AuditEvent"."sequence";

CREATE UNIQUE INDEX "AuditEvent_sequence_key" ON "AuditEvent"("sequence");
