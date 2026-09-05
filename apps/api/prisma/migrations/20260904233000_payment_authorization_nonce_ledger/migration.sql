-- Append-only ERC-3009 nonce history. The mutable PaymentAuthorization row is
-- only the current snapshot and cannot by itself detect A -> B -> A replay.

BEGIN;

-- Keep the evidence snapshot stable for the duration of the backfill. Deploy
-- this migration before starting application instances that write the ledger.
LOCK TABLE "AuditEvent" IN SHARE MODE;
LOCK TABLE "PaymentAuthorization" IN SHARE MODE;
LOCK TABLE "Purchase" IN SHARE MODE;

CREATE TABLE "PaymentAuthorizationNonce" (
    "id" UUID NOT NULL,
    "purchaseId" UUID NOT NULL,
    "paymentId" VARCHAR(128) NOT NULL,
    "nonce" CHAR(66) NOT NULL,
    "typedDataHash" CHAR(66) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAuthorizationNonce_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PaymentAuthorizationNonce_lowercase_nonce_check"
      CHECK ("nonce" = lower("nonce")),
    CONSTRAINT "PaymentAuthorizationNonce_nonce_format_check"
      CHECK ("nonce" ~ '^0x[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "PaymentAuthorizationNonce_nonce_key"
ON "PaymentAuthorizationNonce"("nonce");

CREATE INDEX "PaymentAuthorizationNonce_purchaseId_createdAt_idx"
ON "PaymentAuthorizationNonce"("purchaseId", "createdAt");

CREATE INDEX "PaymentAuthorizationNonce_paymentId_createdAt_idx"
ON "PaymentAuthorizationNonce"("paymentId", "createdAt");

ALTER TABLE "PaymentAuthorizationNonce"
ADD CONSTRAINT "PaymentAuthorizationNonce_purchaseId_fkey"
FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Every authorization audit event is historical evidence. If any such event
-- lacks a canonical bytes32 nonce/hash or an exact Purchase/payment pair, the
-- complete history cannot be reconstructed safely and the migration must stop.
DO $$
DECLARE
  invalid_event_id UUID;
BEGIN
  SELECT event."id"
  INTO invalid_event_id
  FROM "AuditEvent" AS event
  WHERE event."eventType" IN (
    'AUTHORIZATION_SIGNED',
    'AUTHORIZATION_SIMULATED',
    'AUTHORIZATION_RENEGOTIATED'
  )
    AND (
      event."purchaseId" IS NULL
      OR event."paymentId" IS NULL
      OR btrim(event."paymentId") = ''
      OR jsonb_typeof(event."payload" -> 'nonce') IS DISTINCT FROM 'string'
      OR (event."payload" ->> 'nonce') !~ '^0[xX][0-9a-fA-F]{64}$'
      OR jsonb_typeof(event."payload" -> 'typedDataHash') IS DISTINCT FROM 'string'
      OR (event."payload" ->> 'typedDataHash') !~ '^0[xX][0-9a-fA-F]{64}$'
      OR NOT EXISTS (
        SELECT 1
        FROM "Purchase" AS purchase
        WHERE purchase."id" = event."purchaseId"
          AND purchase."paymentId" = event."paymentId"
      )
    )
  ORDER BY event."createdAt", event."id"
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Cannot reconstruct authorization nonce ledger: AuditEvent % has incomplete or inconsistent authorization evidence',
      invalid_event_id;
  END IF;
END $$;

-- The current snapshot is supplementary evidence. It must be independently
-- well-formed and belong to the same Purchase/payment pair.
DO $$
DECLARE
  invalid_authorization_id UUID;
BEGIN
  SELECT current_auth."id"
  INTO invalid_authorization_id
  FROM "PaymentAuthorization" AS current_auth
  WHERE current_auth."nonce" !~ '^0[xX][0-9a-fA-F]{64}$'
    OR current_auth."typedDataHash" !~ '^0[xX][0-9a-fA-F]{64}$'
    OR NOT EXISTS (
      SELECT 1
      FROM "Purchase" AS purchase
      WHERE purchase."id" = current_auth."purchaseId"
        AND purchase."paymentId" = current_auth."paymentId"
    )
  ORDER BY current_auth."createdAt", current_auth."id"
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Cannot reconstruct authorization nonce ledger: PaymentAuthorization % has incomplete or inconsistent authorization evidence',
      invalid_authorization_id;
  END IF;
END $$;

-- Case is not part of bytes32 identity. Exact duplicate events are expected and
-- are deduplicated, but a case-normalized nonce claimed by different evidence is
-- an unsafe collision rather than a row that may be silently discarded.
DO $$
DECLARE
  conflicting_nonce TEXT;
BEGIN
  WITH authorization_claims AS (
    SELECT
      lower(event."payload" ->> 'nonce') AS nonce,
      event."purchaseId" AS "purchaseId",
      event."paymentId" AS "paymentId",
      lower(event."payload" ->> 'typedDataHash') AS "typedDataHash"
    FROM "AuditEvent" AS event
    WHERE event."eventType" IN (
      'AUTHORIZATION_SIGNED',
      'AUTHORIZATION_SIMULATED',
      'AUTHORIZATION_RENEGOTIATED'
    )

    UNION ALL

    SELECT
      lower(current_auth."nonce") AS nonce,
      current_auth."purchaseId" AS "purchaseId",
      current_auth."paymentId" AS "paymentId",
      lower(current_auth."typedDataHash") AS "typedDataHash"
    FROM "PaymentAuthorization" AS current_auth
  ), distinct_claims AS (
    SELECT DISTINCT nonce, "purchaseId", "paymentId", "typedDataHash"
    FROM authorization_claims
  )
  SELECT nonce
  INTO conflicting_nonce
  FROM distinct_claims
  GROUP BY nonce
  HAVING count(*) > 1
  ORDER BY nonce
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Cannot reconstruct authorization nonce ledger: a case-normalized nonce is claimed by conflicting authorization evidence';
  END IF;
END $$;

-- Rebuild the full known history first. DISTINCT ON keeps the earliest event for
-- identical repeated evidence while lower() prevents case-only replay aliases.
INSERT INTO "PaymentAuthorizationNonce" (
  "id", "purchaseId", "paymentId", "nonce", "typedDataHash", "createdAt"
)
SELECT
  gen_random_uuid(),
  history."purchaseId",
  history."paymentId",
  history."nonce",
  history."typedDataHash",
  history."createdAt"
FROM (
  SELECT DISTINCT ON (lower(event."payload" ->> 'nonce'))
    event."purchaseId" AS "purchaseId",
    event."paymentId" AS "paymentId",
    lower(event."payload" ->> 'nonce') AS nonce,
    lower(event."payload" ->> 'typedDataHash') AS "typedDataHash",
    event."createdAt" AS "createdAt"
  FROM "AuditEvent" AS event
  WHERE event."eventType" IN (
    'AUTHORIZATION_SIGNED',
    'AUTHORIZATION_SIMULATED',
    'AUTHORIZATION_RENEGOTIATED'
  )
  ORDER BY lower(event."payload" ->> 'nonce'), event."createdAt", event."id"
) AS history;

-- Finally add any current snapshot that predates audit-event recording or whose
-- historical event is otherwise absent. Existing historical nonces always win.
INSERT INTO "PaymentAuthorizationNonce" (
  "id", "purchaseId", "paymentId", "nonce", "typedDataHash", "createdAt"
)
SELECT
  gen_random_uuid(),
  current_auth."purchaseId",
  current_auth."paymentId",
  lower(current_auth."nonce"),
  lower(current_auth."typedDataHash"),
  current_auth."createdAt"
FROM "PaymentAuthorization" AS current_auth
WHERE NOT EXISTS (
  SELECT 1
  FROM "PaymentAuthorizationNonce" AS history
  WHERE history."nonce" = lower(current_auth."nonce")
);

COMMIT;
