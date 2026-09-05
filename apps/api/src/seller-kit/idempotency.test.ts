import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import {
  createRequestFingerprint,
  InMemoryIdempotencyStore,
} from "./idempotency.js";

const REQUIREMENTS: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  amount: "50000",
  payTo: "0x2222222222222222222222222222222222222222",
  maxTimeoutSeconds: 300,
  extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" },
};

function fingerprint(
  overrides: Partial<PaymentRequirements> = {},
  body: unknown = { targetCompanyName: "Example Co." },
): string {
  return createRequestFingerprint({
    sellerId: "seller-b",
    method: "POST",
    path: "/v1/credit-report",
    body,
    requirements: { ...REQUIREMENTS, ...overrides },
  });
}

describe("seller idempotency", () => {
  it("binds the fingerprint to body and all approved payment terms", () => {
    const baseline = fingerprint();

    expect(fingerprint({}, { targetCompanyName: "Different Co." })).not.toBe(
      baseline,
    );
    expect(fingerprint({ amount: "50001" })).not.toBe(baseline);
    expect(
      fingerprint({ payTo: "0x3333333333333333333333333333333333333333" }),
    ).not.toBe(baseline);
    expect(
      fingerprint({ asset: "0x4444444444444444444444444444444444444444" }),
    ).not.toBe(baseline);
    expect(fingerprint({ network: "eip155:8453" })).not.toBe(baseline);
    expect(fingerprint({ scheme: "different" })).not.toBe(baseline);
    expect(fingerprint({ maxTimeoutSeconds: 299 })).not.toBe(baseline);
    expect(
      fingerprint({
        extra: {
          name: "USDC",
          version: "2",
          assetTransferMethod: "permit2",
        },
      }),
    ).not.toBe(baseline);
  });

  it("atomically claims and permanently retains the completed fingerprint", async () => {
    let now = 1_000;
    const store = new InMemoryIdempotencyStore(100, () => now);
    const baseline = fingerprint();
    const claim = await store.claim(
      "seller-b",
      "POST",
      "/v1/credit-report",
      "pay_test_00000001",
      baseline,
    );
    expect(claim.kind).toBe("acquired");
    if (claim.kind !== "acquired") throw new Error("Expected claim ownership");
    await store.complete(
      "seller-b",
      "POST",
      "/v1/credit-report",
      "pay_test_00000001",
      claim.claimToken,
      {
        fingerprint: baseline,
        statusCode: 200,
        body: { reportId: "original" },
        paymentResponseHeader: "encoded-settlement",
      },
    );

    const hit = await store.lookup(
      "seller-b",
      "POST",
      "/v1/credit-report",
      "pay_test_00000001",
      baseline,
    );
    expect(hit.kind).toBe("hit");
    if (hit.kind === "hit") {
      (hit.entry.body as { reportId: string }).reportId = "mutated";
    }
    expect(
      await store.lookup(
        "seller-b",
        "POST",
        "/v1/credit-report",
        "pay_test_00000001",
        baseline,
      ),
    ).toMatchObject({ kind: "hit", entry: { body: { reportId: "original" } } });
    expect(
      (
        await store.lookup(
          "seller-b",
          "POST",
          "/v1/credit-report",
          "pay_test_00000001",
          fingerprint({ amount: "50001" }),
        )
      ).kind,
    ).toBe("conflict");

    now += 100;
    await expect(
      store.lookup(
        "seller-b",
        "POST",
        "/v1/credit-report",
        "pay_test_00000001",
        baseline,
      ),
    ).resolves.toMatchObject({ kind: "hit" });
    await expect(
      store.claim(
        "seller-b",
        "POST",
        "/v1/credit-report",
        "pay_test_00000001",
        fingerprint({ amount: "50001" }),
      ),
    ).resolves.toMatchObject({ kind: "conflict", fingerprint: baseline });
    await expect(
      store.claim(
        "seller-b",
        "POST",
        "/v1/credit-report",
        "pay_test_00000001",
        baseline,
      ),
    ).resolves.toMatchObject({ kind: "hit" });
  });

  it("grants only one concurrent pre-settlement claim", async () => {
    const store = new InMemoryIdempotencyStore();
    const baseline = fingerprint();
    const claims = await Promise.all(
      Array.from({ length: 20 }, () =>
        store.claim(
          "seller-b",
          "POST",
          "/v1/credit-report",
          "pay_test_00000002",
          baseline,
        ),
      ),
    );

    expect(claims.filter((claim) => claim.kind === "acquired")).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind === "processing")).toHaveLength(19);
  });

  it("never lease-reclaims a claim after the settlement fence", async () => {
    let now = 1_000;
    const store = new InMemoryIdempotencyStore(1_000, () => now, 100);
    const baseline = fingerprint();
    const claim = await store.claim(
      "seller-b",
      "POST",
      "/v1/credit-report",
      "pay_test_fenced_000003",
      baseline,
    );
    expect(claim.kind).toBe("acquired");
    if (claim.kind !== "acquired") throw new Error("Expected claim ownership");

    await store.beginSettlement(
      "seller-b",
      "POST",
      "/v1/credit-report",
      "pay_test_fenced_000003",
      baseline,
      claim.claimToken,
    );
    now += 10_000;

    await expect(
      store.claim(
        "seller-b",
        "POST",
        "/v1/credit-report",
        "pay_test_fenced_000003",
        baseline,
      ),
    ).resolves.toMatchObject({ kind: "processing" });
    await expect(
      store.claim(
        "seller-b",
        "POST",
        "/v1/credit-report",
        "pay_test_fenced_000003",
        fingerprint({ amount: "50001" }),
      ),
    ).resolves.toMatchObject({ kind: "conflict", fingerprint: baseline });

    await expect(
      store.complete(
        "seller-b",
        "POST",
        "/v1/credit-report",
        "pay_test_fenced_000003",
        claim.claimToken,
        {
          fingerprint: baseline,
          statusCode: 200,
          body: { reportId: "settled-once" },
          paymentResponseHeader: "settlement-header",
        },
      ),
    ).resolves.toMatchObject({ body: { reportId: "settled-once" } });
  });
});
