CREATE TABLE "TaskControl" (
  "taskId" UUID NOT NULL PRIMARY KEY REFERENCES "Task"("id") ON DELETE CASCADE,
  "requestKey" VARCHAR(128) NOT NULL UNIQUE,
  "requestHash" VARCHAR(66) NOT NULL,
  "approvalLimitAtomic" VARCHAR(78),
  "expectedPayTo" VARCHAR(42),
  "pendingTerms" JSONB,
  "approvedTermsHash" VARCHAR(66),
  "approvedAt" TIMESTAMPTZ(3),
  "paymentReleaseGrantedAt" TIMESTAMPTZ(3)
);
CREATE TABLE "PaymentControl" (
  "id" VARCHAR(32) NOT NULL PRIMARY KEY,
  "paymentsFrozen" BOOLEAN NOT NULL DEFAULT FALSE,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
