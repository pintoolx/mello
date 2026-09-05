-- Associate spend reservations with the company whose policy authorized them.
BEGIN;

ALTER TABLE "Purchase" ADD COLUMN "buyerProfileId" UUID;

-- The v2 demo originally supported one company profile. Existing purchases have
-- no durable evidence that identifies a buyer, so only the unambiguous one-profile
-- upgrade is safe. Never silently assign them to an arbitrary profile.
DO $$
DECLARE
  purchase_count BIGINT;
  company_profile_count BIGINT;
BEGIN
  SELECT count(*) INTO purchase_count FROM "Purchase";
  SELECT count(*) INTO company_profile_count FROM "CompanyProfile";

  IF purchase_count > 0 AND company_profile_count <> 1 THEN
    RAISE EXCEPTION
      'Cannot backfill Purchase.buyerProfileId: % existing purchases require exactly one CompanyProfile, found %',
      purchase_count,
      company_profile_count;
  END IF;
END $$;

UPDATE "Purchase"
SET "buyerProfileId" = (
  SELECT "id"
  FROM "CompanyProfile"
)
WHERE "buyerProfileId" IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Purchase" WHERE "buyerProfileId" IS NULL) THEN
    RAISE EXCEPTION 'Cannot assign existing purchases without a company profile';
  END IF;
END $$;

ALTER TABLE "Purchase" ALTER COLUMN "buyerProfileId" SET NOT NULL;

-- Retry claims are operation-level compare-and-set guards. Keeping the
-- retryable status unchanged lets a crashed durable job release/reclaim safely.
ALTER TABLE "Invoice"
  ADD COLUMN "retryClaimId" UUID,
  ADD COLUMN "retryClaimedAt" TIMESTAMPTZ(3);

ALTER TABLE "OnchainAnchor"
  ADD COLUMN "retryClaimId" UUID,
  ADD COLUMN "retryClaimedAt" TIMESTAMPTZ(3);

CREATE INDEX "Purchase_buyerProfileId_createdAt_idx"
  ON "Purchase"("buyerProfileId", "createdAt");

ALTER TABLE "Purchase"
  ADD CONSTRAINT "Purchase_buyerProfileId_fkey"
  FOREIGN KEY ("buyerProfileId") REFERENCES "CompanyProfile"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
