CREATE TABLE "ServiceVerification" (
    "serviceId" VARCHAR(64) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(16) NOT NULL CHECK ("status" IN ('VERIFIED', 'REVOKED')),
    "bindingHash" VARCHAR(66) NOT NULL,
    "scopes" JSONB NOT NULL,
    "evidenceRef" VARCHAR(200) NOT NULL,
    "reviewedBy" VARCHAR(64) NOT NULL,
    "reviewedAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "revokeReason" VARCHAR(200),
    CONSTRAINT "ServiceVerification_pkey" PRIMARY KEY ("serviceId"),
    CONSTRAINT "ServiceVerification_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
ALTER TABLE "Purchase" ADD COLUMN "discoveryEvidence" JSONB;
-- Intentionally no approval/backfill: ACTIVE is not VERIFIED.
