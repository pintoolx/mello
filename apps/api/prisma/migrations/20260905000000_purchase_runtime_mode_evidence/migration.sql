-- Runtime modes are immutable evidence for each purchase. Without these
-- snapshots, changing the process configuration could make an old mock hash
-- look like a Base Sepolia transaction in the detail API.
ALTER TABLE "Purchase"
  ADD COLUMN "agentMode" VARCHAR(16) NOT NULL DEFAULT 'demo',
  ADD COLUMN "paymentMode" VARCHAR(16) NOT NULL DEFAULT 'mock',
  ADD COLUMN "invoiceMode" VARCHAR(32) NOT NULL DEFAULT 'mock',
  ADD COLUMN "anchorMode" VARCHAR(16) NOT NULL DEFAULT 'mock',
  ADD COLUMN "paymentExplorerBase" VARCHAR(255),
  ADD COLUMN "anchorExplorerBase" VARCHAR(255);

-- Explorer provenance cannot be reconstructed safely for old rows because an
-- `onchain` run may have used local Anvil. Leave both URLs NULL (fail closed).

-- Best-effort classification for records created before mode snapshots were
-- available. Signed authorizations are real x402; a stored contract address is
-- an on-chain anchor; and the invoice row already records its provider.
UPDATE "Purchase" AS purchase
SET "paymentMode" = 'x402'
WHERE EXISTS (
  SELECT 1
  FROM "PaymentAuthorization" AS auth_record
  WHERE auth_record."purchaseId" = purchase."id"
    AND auth_record."signatureHash" IS NOT NULL
);

UPDATE "Purchase" AS purchase
SET "anchorMode" = 'onchain'
WHERE EXISTS (
  SELECT 1
  FROM "OnchainAnchor" AS anchor
  WHERE anchor."purchaseId" = purchase."id"
    AND anchor."contractAddress" IS NOT NULL
);

UPDATE "Purchase" AS purchase
SET "invoiceMode" = CASE invoice."provider"::text
  WHEN 'ECPAY_STAGE' THEN 'ecpay_stage'
  ELSE 'mock'
END
FROM "Invoice" AS invoice
WHERE invoice."purchaseId" = purchase."id";
