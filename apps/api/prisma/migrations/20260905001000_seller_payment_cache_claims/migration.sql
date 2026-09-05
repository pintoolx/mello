-- CreateEnum
CREATE TYPE "SellerPaymentCacheStatus" AS ENUM ('PROCESSING', 'COMPLETED');

-- Existing rows were written only after a response had completed. Preserve
-- them as completed cache entries while introducing pre-settlement claims.
ALTER TABLE "SellerPaymentCache"
  ALTER COLUMN "responseStatus" DROP NOT NULL,
  ALTER COLUMN "responseHeaders" DROP NOT NULL,
  ALTER COLUMN "responseBody" DROP NOT NULL,
  ADD COLUMN "status" "SellerPaymentCacheStatus" NOT NULL DEFAULT 'COMPLETED',
  ADD COLUMN "claimToken" UUID,
  ADD COLUMN "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "SellerPaymentCache"
SET "claimToken" = gen_random_uuid()
WHERE "claimToken" IS NULL;

ALTER TABLE "SellerPaymentCache"
  ALTER COLUMN "claimToken" SET NOT NULL,
  ALTER COLUMN "status" SET DEFAULT 'PROCESSING',
  ALTER COLUMN "updatedAt" DROP DEFAULT;
