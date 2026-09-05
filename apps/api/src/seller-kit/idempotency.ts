import { randomUUID } from "node:crypto";
import { Prisma, prisma, type PrismaClient } from "@mello/db";
import { hashCanonicalJson } from "@mello/shared";
import type {
  CachedSellerResponse,
  CacheLookup,
  FingerprintInput,
  IdempotencyClaim,
  SellerIdempotencyStore,
} from "./types.js";

export const DEFAULT_IDEMPOTENCY_TTL_MS = 60 * 60 * 1_000;
export const DEFAULT_IDEMPOTENCY_CLAIM_LEASE_MS = 2 * 60 * 1_000;
export const DEFAULT_IDEMPOTENCY_WAIT_TIMEOUT_MS = 5_000;
export const DEFAULT_IDEMPOTENCY_POLL_INTERVAL_MS = 50;
const PERMANENT_COMPLETION_EXPIRY_MS = Date.parse("9999-12-31T23:59:59.999Z");

function cacheKey(
  sellerId: string,
  method: string,
  path: string,
  paymentId: string,
): string {
  return [sellerId, method.toUpperCase(), path, paymentId].join(":");
}

function databaseRoute(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

export function createRequestFingerprint(input: FingerprintInput): string {
  return hashCanonicalJson({
    schemaVersion: "1",
    sellerId: input.sellerId,
    method: input.method.toUpperCase(),
    path: input.path,
    body: input.body,
    scheme: input.requirements.scheme,
    network: input.requirements.network,
    asset: input.requirements.asset.toLowerCase(),
    amount: input.requirements.amount,
    payTo: input.requirements.payTo.toLowerCase(),
    maxTimeoutSeconds: input.requirements.maxTimeoutSeconds,
    extra: input.requirements.extra,
    paymentPayloadHash: input.paymentPayloadHash,
  });
}

/**
 * Binds a cache hit to the exact signed x402 payload without retaining its
 * signature or authorization fields.
 */
export function createPaymentPayloadHash(payload: unknown): string {
  return hashCanonicalJson({
    schemaVersion: "x402-payment-payload-1",
    payload,
  });
}

interface ProcessingEntry {
  status: "PROCESSING";
  fingerprint: string;
  claimToken: string;
  expiresAtMs: number;
}

interface SettlingEntry {
  status: "SETTLING";
  fingerprint: string;
  claimToken: string;
  expiresAtMs: number;
}

interface CompletedEntry {
  status: "COMPLETED";
  fingerprint: string;
  claimToken: string;
  expiresAtMs: number;
  response: CachedSellerResponse;
}

type MemoryEntry = ProcessingEntry | SettlingEntry | CompletedEntry;

/** Explicit test/development double. Production entrypoints use Postgres. */
export class InMemoryIdempotencyStore implements SellerIdempotencyStore {
  readonly #entries = new Map<string, MemoryEntry>();
  readonly #claimLeaseMs: number;
  readonly #now: () => number;

  constructor(
    ttlMs = DEFAULT_IDEMPOTENCY_TTL_MS,
    now: () => number = Date.now,
    claimLeaseMs = DEFAULT_IDEMPOTENCY_CLAIM_LEASE_MS,
  ) {
    assertPositiveSafeInteger(ttlMs, "Idempotency TTL");
    assertPositiveSafeInteger(claimLeaseMs, "Idempotency claim lease");
    this.#claimLeaseMs = claimLeaseMs;
    this.#now = now;
  }

  async claim(
    sellerId: string,
    method: string,
    path: string,
    paymentId: string,
    fingerprint: string,
  ): Promise<IdempotencyClaim> {
    const key = cacheKey(sellerId, method, path, paymentId);
    const now = this.#now();
    const existing = this.#entries.get(key);

    if (!existing) {
      const claimToken = randomUUID();
      this.#entries.set(key, {
        status: "PROCESSING",
        fingerprint,
        claimToken,
        expiresAtMs: now + this.#claimLeaseMs,
      });
      return { kind: "acquired", claimToken };
    }
    if (existing.fingerprint !== fingerprint) {
      return { kind: "conflict", fingerprint: existing.fingerprint };
    }
    if (existing.status === "COMPLETED") {
      return { kind: "hit", entry: structuredClone(existing.response) };
    }
    if (existing.status === "SETTLING") {
      return { kind: "processing", retryAfterMs: 1_000 };
    }
    if (existing.expiresAtMs <= now) {
      const claimToken = randomUUID();
      this.#entries.set(key, {
        status: "PROCESSING",
        fingerprint,
        claimToken,
        expiresAtMs: now + this.#claimLeaseMs,
      });
      return { kind: "acquired", claimToken };
    }
    return {
      kind: "processing",
      retryAfterMs: Math.max(1, existing.expiresAtMs - now),
    };
  }

  async lookup(
    sellerId: string,
    method: string,
    path: string,
    paymentId: string,
    fingerprint: string,
  ): Promise<CacheLookup> {
    const key = cacheKey(sellerId, method, path, paymentId);
    const now = this.#now();
    const existing = this.#entries.get(key);

    if (!existing) return { kind: "miss" };
    if (existing.fingerprint !== fingerprint) {
      return { kind: "conflict", fingerprint: existing.fingerprint };
    }
    if (existing.status === "COMPLETED") {
      return { kind: "hit", entry: structuredClone(existing.response) };
    }
    if (existing.status === "SETTLING") {
      return { kind: "processing", retryAfterMs: 1_000 };
    }
    if (existing.expiresAtMs <= now) return { kind: "miss" };
    return {
      kind: "processing",
      retryAfterMs: Math.max(1, existing.expiresAtMs - now),
    };
  }

  async beginSettlement(
    sellerId: string,
    method: string,
    path: string,
    paymentId: string,
    fingerprint: string,
    claimToken: string,
  ): Promise<void> {
    const key = cacheKey(sellerId, method, path, paymentId);
    const existing = this.#entries.get(key);
    if (
      !existing ||
      existing.status === "COMPLETED" ||
      existing.fingerprint !== fingerprint ||
      existing.claimToken !== claimToken
    ) {
      throw new Error("IDEMPOTENCY_CLAIM_LOST");
    }
    if (existing.status === "SETTLING") return;
    this.#entries.set(key, {
      status: "SETTLING",
      fingerprint,
      claimToken,
      expiresAtMs: PERMANENT_COMPLETION_EXPIRY_MS,
    });
  }

  async complete(
    sellerId: string,
    method: string,
    path: string,
    paymentId: string,
    claimToken: string,
    entry: Omit<CachedSellerResponse, "createdAtMs">,
  ): Promise<CachedSellerResponse> {
    const key = cacheKey(sellerId, method, path, paymentId);
    const existing = this.#entries.get(key);
    if (!existing || existing.fingerprint !== entry.fingerprint) {
      throw new Error("IDEMPOTENCY_CLAIM_LOST");
    }
    if (existing.status === "COMPLETED") {
      if (existing.claimToken !== claimToken) {
        throw new Error("IDEMPOTENCY_CLAIM_LOST");
      }
      return structuredClone(existing.response);
    }
    if (existing.claimToken !== claimToken) {
      throw new Error("IDEMPOTENCY_CLAIM_LOST");
    }

    const now = this.#now();
    const response = {
      ...structuredClone(entry),
      createdAtMs: now,
    } satisfies CachedSellerResponse;
    this.#entries.set(key, {
      status: "COMPLETED",
      fingerprint: entry.fingerprint,
      claimToken,
      expiresAtMs: PERMANENT_COMPLETION_EXPIRY_MS,
      response,
    });
    return structuredClone(response);
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}

interface SellerPaymentCacheRow {
  fingerprint: string;
  status: "PROCESSING" | "SETTLING" | "COMPLETED";
  claimToken: string;
  responseStatus: number | null;
  responseHeaders: Prisma.JsonValue | null;
  responseBody: Prisma.JsonValue | null;
  expiresAt: Date;
  updatedAt: Date;
}

export interface PostgresIdempotencyStoreOptions {
  /**
   * Accepted for compatibility with seller configuration. Completed P0
   * payment bindings are intentionally retained permanently; only processing
   * claims expire and can be reclaimed.
   */
  ttlMs?: number;
  claimLeaseMs?: number;
  now?: () => number;
}

function paymentResponseHeaderFromJson(value: Prisma.JsonValue | null): string | null {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  const header = value["payment-response"];
  return typeof header === "string" ? header : null;
}

function completedResponse(row: SellerPaymentCacheRow): CachedSellerResponse {
  const paymentResponseHeader = paymentResponseHeaderFromJson(row.responseHeaders);
  if (
    row.status !== "COMPLETED" ||
    row.responseStatus === null ||
    row.responseBody === null ||
    paymentResponseHeader === null
  ) {
    throw new Error("INVALID_COMPLETED_IDEMPOTENCY_ROW");
  }
  return {
    fingerprint: row.fingerprint,
    statusCode: row.responseStatus,
    body: row.responseBody,
    createdAtMs: row.updatedAt.getTime(),
    paymentResponseHeader,
  };
}

export class PostgresIdempotencyStore implements SellerIdempotencyStore {
  readonly #client: PrismaClient;
  readonly #claimLeaseMs: number;
  readonly #now: () => number;

  constructor(
    client: PrismaClient = prisma,
    options: PostgresIdempotencyStoreOptions = {},
  ) {
    this.#client = client;
    const ttlMs = options.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
    this.#claimLeaseMs =
      options.claimLeaseMs ?? DEFAULT_IDEMPOTENCY_CLAIM_LEASE_MS;
    this.#now = options.now ?? Date.now;
    assertPositiveSafeInteger(ttlMs, "Idempotency TTL");
    assertPositiveSafeInteger(this.#claimLeaseMs, "Idempotency claim lease");
  }

  async claim(
    sellerId: string,
    method: string,
    path: string,
    paymentId: string,
    fingerprint: string,
  ): Promise<IdempotencyClaim> {
    const route = databaseRoute(method, path);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const now = new Date(this.#now());
      const expiresAt = new Date(now.getTime() + this.#claimLeaseMs);
      const id = randomUUID();
      const claimToken = randomUUID();
      const claimed = await this.#client.$queryRaw<Array<{ claimToken: string }>>(
        Prisma.sql`
          INSERT INTO "SellerPaymentCache" (
            "id", "sellerId", "route", "paymentId", "fingerprint",
            "status", "claimToken", "expiresAt", "createdAt", "updatedAt"
          ) VALUES (
            ${id}::uuid, ${sellerId}, ${route}, ${paymentId}, ${fingerprint},
            'PROCESSING'::"SellerPaymentCacheStatus", ${claimToken}::uuid,
            ${expiresAt}, ${now}, ${now}
          )
          ON CONFLICT ("sellerId", "route", "paymentId") DO UPDATE SET
            "status" = 'PROCESSING'::"SellerPaymentCacheStatus",
            "claimToken" = EXCLUDED."claimToken",
            "responseStatus" = NULL,
            "responseHeaders" = NULL,
            "responseBody" = NULL,
            "settlementMetadata" = NULL,
            "expiresAt" = EXCLUDED."expiresAt",
            "createdAt" = EXCLUDED."createdAt",
            "updatedAt" = EXCLUDED."updatedAt"
          WHERE "SellerPaymentCache"."expiresAt" <= ${now}
            AND "SellerPaymentCache"."fingerprint" = EXCLUDED."fingerprint"
            AND "SellerPaymentCache"."status" = 'PROCESSING'::"SellerPaymentCacheStatus"
          RETURNING "claimToken"
        `,
      );
      if (claimed[0]?.claimToken === claimToken) {
        return { kind: "acquired", claimToken };
      }

      const lookup = await this.lookup(
        sellerId,
        method,
        path,
        paymentId,
        fingerprint,
      );
      if (lookup.kind !== "miss") return lookup;
    }

    throw new Error("IDEMPOTENCY_CLAIM_CONTENTION");
  }

  async lookup(
    sellerId: string,
    method: string,
    path: string,
    paymentId: string,
    fingerprint: string,
  ): Promise<CacheLookup> {
    const rows = await this.#client.$queryRaw<SellerPaymentCacheRow[]>(
      Prisma.sql`
        SELECT
          "fingerprint", "status", "claimToken", "responseStatus",
          "responseHeaders", "responseBody", "expiresAt", "updatedAt"
        FROM "SellerPaymentCache"
        WHERE "sellerId" = ${sellerId}
          AND "route" = ${databaseRoute(method, path)}
          AND "paymentId" = ${paymentId}
        LIMIT 1
      `,
    );
    const row = rows[0];
    if (!row) return { kind: "miss" };
    if (row.fingerprint !== fingerprint) {
      return { kind: "conflict", fingerprint: row.fingerprint };
    }
    if (row.status === "COMPLETED") {
      return { kind: "hit", entry: completedResponse(row) };
    }
    if (row.status === "SETTLING") {
      return { kind: "processing", retryAfterMs: 1_000 };
    }
    if (row.expiresAt.getTime() <= this.#now()) return { kind: "miss" };
    return {
      kind: "processing",
      retryAfterMs: Math.max(1, row.expiresAt.getTime() - this.#now()),
    };
  }

  async beginSettlement(
    sellerId: string,
    method: string,
    path: string,
    paymentId: string,
    fingerprint: string,
    claimToken: string,
  ): Promise<void> {
    const now = new Date(this.#now());
    const expiresAt = new Date(PERMANENT_COMPLETION_EXPIRY_MS);
    const rows = await this.#client.$queryRaw<Array<{ claimToken: string }>>(
      Prisma.sql`
        UPDATE "SellerPaymentCache"
        SET
          "status" = 'SETTLING'::"SellerPaymentCacheStatus",
          "expiresAt" = ${expiresAt},
          "updatedAt" = ${now}
        WHERE "sellerId" = ${sellerId}
          AND "route" = ${databaseRoute(method, path)}
          AND "paymentId" = ${paymentId}
          AND "fingerprint" = ${fingerprint}
          AND "status" = 'PROCESSING'::"SellerPaymentCacheStatus"
          AND "claimToken" = ${claimToken}::uuid
        RETURNING "claimToken"
      `,
    );
    if (rows[0]?.claimToken === claimToken) return;

    const existing = await this.#client.$queryRaw<SellerPaymentCacheRow[]>(
      Prisma.sql`
        SELECT
          "fingerprint", "status", "claimToken", "responseStatus",
          "responseHeaders", "responseBody", "expiresAt", "updatedAt"
        FROM "SellerPaymentCache"
        WHERE "sellerId" = ${sellerId}
          AND "route" = ${databaseRoute(method, path)}
          AND "paymentId" = ${paymentId}
        LIMIT 1
      `,
    );
    if (
      existing[0]?.status === "SETTLING" &&
      existing[0].fingerprint === fingerprint &&
      existing[0].claimToken === claimToken
    ) {
      return;
    }
    throw new Error("IDEMPOTENCY_CLAIM_LOST");
  }

  async complete(
    sellerId: string,
    method: string,
    path: string,
    paymentId: string,
    claimToken: string,
    entry: Omit<CachedSellerResponse, "createdAtMs">,
  ): Promise<CachedSellerResponse> {
    const now = new Date(this.#now());
    const expiresAt = new Date(PERMANENT_COMPLETION_EXPIRY_MS);
    const responseHeaders = JSON.stringify({
      "payment-response": entry.paymentResponseHeader,
    });
    const responseBody = JSON.stringify(entry.body ?? null);
    const rows = await this.#client.$queryRaw<SellerPaymentCacheRow[]>(
      Prisma.sql`
        UPDATE "SellerPaymentCache"
        SET
          "status" = 'COMPLETED'::"SellerPaymentCacheStatus",
          "responseStatus" = ${entry.statusCode},
          "responseHeaders" = ${responseHeaders}::jsonb,
          "responseBody" = ${responseBody}::jsonb,
          "expiresAt" = ${expiresAt},
          "updatedAt" = ${now}
        WHERE "sellerId" = ${sellerId}
          AND "route" = ${databaseRoute(method, path)}
          AND "paymentId" = ${paymentId}
          AND "fingerprint" = ${entry.fingerprint}
          AND "status" IN (
            'PROCESSING'::"SellerPaymentCacheStatus",
            'SETTLING'::"SellerPaymentCacheStatus"
          )
          AND "claimToken" = ${claimToken}::uuid
        RETURNING
          "fingerprint", "status", "claimToken", "responseStatus",
          "responseHeaders", "responseBody", "expiresAt", "updatedAt"
      `,
    );
    if (rows[0]) return completedResponse(rows[0]);

    const lookup = await this.lookup(
      sellerId,
      method,
      path,
      paymentId,
      entry.fingerprint,
    );
    if (lookup.kind === "hit") return lookup.entry;
    throw new Error("IDEMPOTENCY_CLAIM_LOST");
  }
}

export function createPostgresIdempotencyStore(
  options: PostgresIdempotencyStoreOptions = {},
): PostgresIdempotencyStore {
  return new PostgresIdempotencyStore(prisma, options);
}
