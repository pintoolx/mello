ALTER TABLE "CompanyProfile"
  ADD COLUMN "contactName" VARCHAR(100) NOT NULL DEFAULT '',
  ADD COLUMN "phone" VARCHAR(32) NOT NULL DEFAULT '',
  ADD COLUMN "address" VARCHAR(255) NOT NULL DEFAULT '',
  ADD COLUMN "invoiceEmail" VARCHAR(254) NOT NULL DEFAULT '',
  ADD COLUMN "invoiceAddress" VARCHAR(255) NOT NULL DEFAULT '';

-- Historical purchases must not be backfilled with today's company details.
ALTER TABLE "Purchase" ADD COLUMN "buyerProfileSnapshot" JSONB;
