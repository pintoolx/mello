import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createPurchaseContextToken,
  verifyPurchaseContextToken,
} from "./purchase-context.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const PAYLOAD = {
  purchaseId: "00000000-0000-4000-8000-000000000010",
  buyerProfileId: "00000000-0000-4000-8000-000000000001",
  sellerId: "seller-b" as const,
};

function encodeUntrustedPayload(payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", SECRET)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

describe("seller purchase context token", () => {
  it("is wire-compatible with Core and verifies opaque purchase identity", () => {
    const token = createPurchaseContextToken(PAYLOAD, SECRET, 1_000);
    const verified = verifyPurchaseContextToken(token, SECRET, 1_001);
    expect(verified).toMatchObject(PAYLOAD);
    expect(Object.keys(verified).sort()).toEqual([
      "buyerProfileId",
      "exp",
      "nonce",
      "purchaseId",
      "sellerId",
    ]);
    expect(token).not.toContain(PAYLOAD.purchaseId);
  });

  it("rejects forged, expired, and structurally invalid purchase identities", () => {
    const token = createPurchaseContextToken(PAYLOAD, SECRET, 1_000);
    expect(() => verifyPurchaseContextToken(`${token}x`, SECRET, 1_001)).toThrow(
      /signature/,
    );
    expect(() => verifyPurchaseContextToken(token, SECRET, 1_600)).toThrow(
      /expired/,
    );

    const badPurchaseId = encodeUntrustedPayload({
      ...PAYLOAD,
      purchaseId: "not-a-purchase-id",
      nonce: "a".repeat(32),
      exp: 2_000,
    });
    expect(() => verifyPurchaseContextToken(badPurchaseId, SECRET, 1_001)).toThrow();

    const forbiddenTaskId = encodeUntrustedPayload({
      ...PAYLOAD,
      taskId: "00000000-0000-4000-8000-000000000999",
      nonce: "a".repeat(32),
      exp: 2_000,
    });
    expect(() =>
      verifyPurchaseContextToken(forbiddenTaskId, SECRET, 1_001),
    ).toThrow();

  });
});
