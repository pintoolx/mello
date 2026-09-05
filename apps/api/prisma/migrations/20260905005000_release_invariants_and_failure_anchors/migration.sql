-- Release invariants that Prisma cannot express directly.

-- The P0 product is intentionally single-company and has exactly one active
-- policy. Database-level uniqueness closes races between concurrent admin
-- requests; application reads are no longer the only enforcement layer.
CREATE UNIQUE INDEX "CompanyProfile_singleton_key"
ON "CompanyProfile" ((true));

CREATE UNIQUE INDEX "Policy_single_active_key"
ON "Policy" ("active")
WHERE "active" = true;

-- Older purchases were created before the FAIL workflow was wired. Give each
-- one its durable terminal-anchor slot without changing successful evidence.
INSERT INTO "OnchainAnchor" (
  "id", "purchaseId", "kind", "status", "attemptCount", "createdAt", "updatedAt"
)
SELECT
  md5(p."id"::text || ':FAIL')::uuid,
  p."id",
  'FAIL'::"AnchorKind",
  'NOT_STARTED'::"AnchorStatus",
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Purchase" p
WHERE NOT EXISTS (
  SELECT 1
  FROM "OnchainAnchor" a
  WHERE a."purchaseId" = p."id" AND a."kind" = 'FAIL'::"AnchorKind"
);

-- Atomic token values remain strings at the API boundary to avoid JavaScript
-- precision loss, but the database rejects anything other than base-10
-- non-negative integers and enforces the policy limit relationship.
ALTER TABLE "Policy"
ADD CONSTRAINT "Policy_atomic_amounts_check"
CHECK (
  "perTxLimitAtomic" ~ '^[0-9]+$'
  AND "dailyLimitAtomic" ~ '^[0-9]+$'
  AND "perTxLimitAtomic"::numeric <= "dailyLimitAtomic"::numeric
);

ALTER TABLE "Service"
ADD CONSTRAINT "Service_priceAtomic_check"
CHECK ("priceAtomic" ~ '^[0-9]+$');

ALTER TABLE "Purchase"
ADD CONSTRAINT "Purchase_atomic_amounts_check"
CHECK (
  "expectedAmountAtomic" ~ '^[0-9]+$'
  AND ("actualAmountAtomic" IS NULL OR "actualAmountAtomic" ~ '^[0-9]+$')
);

ALTER TABLE "Payment"
ADD CONSTRAINT "Payment_amountAtomic_check"
CHECK ("amountAtomic" IS NULL OR "amountAtomic" ~ '^[0-9]+$');

ALTER TABLE "PaymentAuthorization"
ADD CONSTRAINT "PaymentAuthorization_amountAtomic_check"
CHECK ("amountAtomic" ~ '^[0-9]+$');

ALTER TABLE "Invoice"
ADD CONSTRAINT "Invoice_atomic_amounts_check"
CHECK (
  ("sourceAmountAtomic" IS NULL OR "sourceAmountAtomic" ~ '^[0-9]+$')
  AND ("twdEquivalentMinor" IS NULL OR "twdEquivalentMinor" ~ '^[0-9]+$')
);

-- Project-wide network/RPC policy is at most three total attempts.
UPDATE "WorkflowJob"
SET "maxAttempts" = 3
WHERE "maxAttempts" > 3;

ALTER TABLE "WorkflowJob"
DROP CONSTRAINT "WorkflowJob_maxAttempts_positive_check",
ADD CONSTRAINT "WorkflowJob_maxAttempts_positive_check"
CHECK ("maxAttempts" BETWEEN 1 AND 3);
