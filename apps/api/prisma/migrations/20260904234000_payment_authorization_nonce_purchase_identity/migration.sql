-- Make each nonce-ledger row prove that its paymentId belongs to the same
-- Purchase as purchaseId. The existing single-column FK cannot enforce this.

BEGIN;

LOCK TABLE "PaymentAuthorizationNonce" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "Purchase" IN SHARE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "PaymentAuthorizationNonce" AS authorization_nonce
    LEFT JOIN "Purchase" AS purchase
      ON purchase."id" = authorization_nonce."purchaseId"
     AND purchase."paymentId" = authorization_nonce."paymentId"
    WHERE purchase."id" IS NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce authorization nonce purchase identity: at least one ledger paymentId does not belong to its purchaseId';
  END IF;
END $$;

-- PostgreSQL requires an exact unique target for a composite foreign key.
CREATE UNIQUE INDEX "Purchase_id_paymentId_key"
ON "Purchase"("id", "paymentId");

ALTER TABLE "PaymentAuthorizationNonce"
DROP CONSTRAINT "PaymentAuthorizationNonce_purchaseId_fkey";

ALTER TABLE "PaymentAuthorizationNonce"
ADD CONSTRAINT "PaymentAuthorizationNonce_purchaseId_paymentId_fkey"
FOREIGN KEY ("purchaseId", "paymentId")
REFERENCES "Purchase"("id", "paymentId")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Index foreign-key columns used for seller/service ownership lookups and
-- delete/update checks. PostgreSQL does not create child-side FK indexes.
CREATE INDEX "Service_sellerId_idx" ON "Service"("sellerId");
CREATE INDEX "Purchase_serviceId_idx" ON "Purchase"("serviceId");

COMMIT;
