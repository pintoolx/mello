import { randomUUID } from "node:crypto";
import { PrismaClient, prisma } from "@mello/db";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { PostgresIdempotencyStore } from "./idempotency.js";

const RUN_INTEGRATION_TESTS =
  process.env["RUN_INTEGRATION_TESTS"] === "true";
const METHOD = "POST";
const PATH = "/v1/credit-report";
const FINGERPRINT_A = `0x${"a".repeat(64)}`;
const FINGERPRINT_B = `0x${"b".repeat(64)}`;
const clients: PrismaClient[] = [];
const sellerIds: string[] = [];

function createStore(
  options: ConstructorParameters<typeof PostgresIdempotencyStore>[1] = {},
): PostgresIdempotencyStore {
  const client = new PrismaClient();
  clients.push(client);
  return new PostgresIdempotencyStore(client, options);
}

function fixture(): { sellerId: string; paymentId: string } {
  const sellerId = `seller-idempotency-${randomUUID()}`;
  sellerIds.push(sellerId);
  return { sellerId, paymentId: `pay_${randomUUID()}` };
}

async function cleanup(): Promise<void> {
  if (sellerIds.length > 0) {
    await prisma.sellerPaymentCache.deleteMany({
      where: { sellerId: { in: sellerIds } },
    });
    sellerIds.splice(0, sellerIds.length);
  }
  await Promise.all(clients.splice(0, clients.length).map((client) => client.$disconnect()));
}

describe.skipIf(!RUN_INTEGRATION_TESTS).sequential(
  "Postgres seller payment idempotency",
  () => {
    afterEach(cleanup);
    afterAll(async () => {
      await cleanup();
      await prisma.$disconnect();
    });

    it("replays the complete response from a new store instance after restart", async () => {
      const { sellerId, paymentId } = fixture();
      const beforeRestart = createStore();
      const claim = await beforeRestart.claim(
        sellerId,
        METHOD,
        PATH,
        paymentId,
        FINGERPRINT_A,
      );
      expect(claim.kind).toBe("acquired");
      if (claim.kind !== "acquired") throw new Error("Expected claim ownership");

      const body = { reportId: randomUUID(), provider: sellerId };
      await beforeRestart.complete(
        sellerId,
        METHOD,
        PATH,
        paymentId,
        claim.claimToken,
        {
          fingerprint: FINGERPRINT_A,
          statusCode: 200,
          body,
          paymentResponseHeader: "encoded-final-settlement-header",
        },
      );
      await clients.shift()?.$disconnect();

      const afterRestart = createStore();
      await expect(
        afterRestart.claim(
          sellerId,
          METHOD,
          PATH,
          paymentId,
          FINGERPRINT_A,
        ),
      ).resolves.toMatchObject({
        kind: "hit",
        entry: {
          statusCode: 200,
          body,
          paymentResponseHeader: "encoded-final-settlement-header",
        },
      });
      await expect(
        afterRestart.claim(
          sellerId,
          METHOD,
          PATH,
          paymentId,
          FINGERPRINT_B,
        ),
      ).resolves.toMatchObject({ kind: "conflict", fingerprint: FINGERPRINT_A });
    });

    it("atomically grants one owner across concurrent store instances", async () => {
      const { sellerId, paymentId } = fixture();
      const stores = Array.from({ length: 8 }, () => createStore());
      const claims = await Promise.all(
        stores.map((store) =>
          store.claim(
            sellerId,
            METHOD,
            PATH,
            paymentId,
            FINGERPRINT_A,
          ),
        ),
      );

      expect(claims.filter((claim) => claim.kind === "acquired")).toHaveLength(1);
      expect(claims.filter((claim) => claim.kind === "processing")).toHaveLength(7);
      await expect(
        prisma.sellerPaymentCache.count({ where: { sellerId, paymentId } }),
      ).resolves.toBe(1);
    });

    it("reclaims only the bound fingerprint and rejects a stale owner", async () => {
      const { sellerId, paymentId } = fixture();
      let now = Date.parse("2030-01-01T00:00:00.000Z");
      const firstStore = createStore({
        claimLeaseMs: 100,
        ttlMs: 1_000,
        now: () => now,
      });
      const secondStore = createStore({
        claimLeaseMs: 100,
        ttlMs: 1_000,
        now: () => now,
      });
      const first = await firstStore.claim(
        sellerId,
        METHOD,
        PATH,
        paymentId,
        FINGERPRINT_A,
      );
      expect(first.kind).toBe("acquired");
      if (first.kind !== "acquired") throw new Error("Expected first claim");

      now += 101;
      await expect(
        secondStore.claim(
          sellerId,
          METHOD,
          PATH,
          paymentId,
          FINGERPRINT_B,
        ),
      ).resolves.toMatchObject({
        kind: "conflict",
        fingerprint: FINGERPRINT_A,
      });
      const replacement = await secondStore.claim(
        sellerId,
        METHOD,
        PATH,
        paymentId,
        FINGERPRINT_A,
      );
      expect(replacement.kind).toBe("acquired");
      if (replacement.kind !== "acquired") throw new Error("Expected replacement claim");

      await expect(
        firstStore.complete(
          sellerId,
          METHOD,
          PATH,
          paymentId,
          first.claimToken,
          {
            fingerprint: FINGERPRINT_A,
            statusCode: 200,
            body: { stale: true },
            paymentResponseHeader: "stale-header",
          },
        ),
      ).rejects.toThrow("IDEMPOTENCY_CLAIM_LOST");
      await expect(
        secondStore.complete(
          sellerId,
          METHOD,
          PATH,
          paymentId,
          replacement.claimToken,
          {
            fingerprint: FINGERPRINT_A,
            statusCode: 200,
            body: { stale: false },
            paymentResponseHeader: "replacement-header",
          },
        ),
      ).resolves.toMatchObject({ body: { stale: false } });

      now += 1_000;
      await expect(
        firstStore.claim(
          sellerId,
          METHOD,
          PATH,
          paymentId,
          FINGERPRINT_B,
        ),
      ).resolves.toMatchObject({
        kind: "conflict",
        fingerprint: FINGERPRINT_A,
      });
      await expect(
        firstStore.claim(
          sellerId,
          METHOD,
          PATH,
          paymentId,
          FINGERPRINT_A,
        ),
      ).resolves.toMatchObject({
        kind: "hit",
        entry: {
          body: { stale: false },
          paymentResponseHeader: "replacement-header",
        },
      });
    });

    it("durably prevents lease takeover after settlement starts", async () => {
      const { sellerId, paymentId } = fixture();
      let now = Date.parse("2030-01-01T00:00:00.000Z");
      const owner = createStore({ claimLeaseMs: 100, now: () => now });
      const retry = createStore({ claimLeaseMs: 100, now: () => now });
      const claim = await owner.claim(
        sellerId,
        METHOD,
        PATH,
        paymentId,
        FINGERPRINT_A,
      );
      expect(claim.kind).toBe("acquired");
      if (claim.kind !== "acquired") throw new Error("Expected claim ownership");

      await owner.beginSettlement(
        sellerId,
        METHOD,
        PATH,
        paymentId,
        FINGERPRINT_A,
        claim.claimToken,
      );
      now += 10_000;

      await expect(
        retry.claim(sellerId, METHOD, PATH, paymentId, FINGERPRINT_A),
      ).resolves.toMatchObject({ kind: "processing" });
      await expect(
        retry.claim(sellerId, METHOD, PATH, paymentId, FINGERPRINT_B),
      ).resolves.toMatchObject({ kind: "conflict", fingerprint: FINGERPRINT_A });

      await expect(
        owner.complete(
          sellerId,
          METHOD,
          PATH,
          paymentId,
          claim.claimToken,
          {
            fingerprint: FINGERPRINT_A,
            statusCode: 200,
            body: { fenced: true },
            paymentResponseHeader: "fenced-settlement-header",
          },
        ),
      ).resolves.toMatchObject({ body: { fenced: true } });
    });
  },
);
