-- Branding is separate from the legal identity used by invoices and certification.
-- Catalog data is migrated by the guarded startup script, never by this DDL.
ALTER TABLE "Seller" ADD COLUMN "displayName" VARCHAR(100);
