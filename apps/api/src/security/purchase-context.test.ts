import { describe, expect, it } from "vitest";
import { createPurchaseContextToken, verifyPurchaseContextToken } from "./purchase-context.js";

const data = {
  purchaseId: "00000000-0000-4000-8000-000000000010",
  buyerProfileId: "00000000-0000-4000-8000-000000000001",
  sellerId: "seller-b" as const,
};

describe("purchase context token", () => {
  it("contains only opaque identifiers and verifies", () => {
    const token = createPurchaseContextToken(data, "0123456789abcdef0123456789abcdef", 1000);
    const payload = verifyPurchaseContextToken(token, "0123456789abcdef0123456789abcdef", 1001);
    expect(payload).toMatchObject(data);
    expect(Object.keys(payload).sort()).toEqual([
      "buyerProfileId",
      "exp",
      "nonce",
      "purchaseId",
      "sellerId",
    ]);
    expect(token).not.toContain("12345675");
  });

  it("rejects tampering and expiration", () => {
    const token = createPurchaseContextToken(data, "0123456789abcdef0123456789abcdef", 1000);
    expect(() => verifyPurchaseContextToken(`${token}x`, "0123456789abcdef0123456789abcdef", 1001)).toThrow();
    expect(() => verifyPurchaseContextToken(token, "0123456789abcdef0123456789abcdef", 1600)).toThrow(
      /expired/,
    );
  });
});
