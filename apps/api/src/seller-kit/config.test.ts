import { describe, expect, it } from "vitest";
import { assertSellerServerConfig } from "./config.js";
import type { SellerServerConfig } from "./types.js";

const BASE_CONFIG: SellerServerConfig = {
  sellerId: "seller-a",
  sellerName: "Mello Seller A",
  port: 4_011,
  publicUrl: "http://localhost:4011",
  paymentMode: "mock",
  facilitatorUrl: "https://x402.org/facilitator",
  network: "eip155:84532",
  tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  tokenDecimals: 6,
  payToAddress: "0x1111111111111111111111111111111111111111",
  priceAtomic: "40000",
  invoiceCapability: "NONE",
  purchaseContextHmacSecret: "0123456789abcdef0123456789abcdef",
};

describe("seller configuration", () => {
  it("allows explicit placeholders only in clearly marked mock mode", () => {
    expect(assertSellerServerConfig(BASE_CONFIG)).toBe(BASE_CONFIG);
    expect(() =>
      assertSellerServerConfig({ ...BASE_CONFIG, paymentMode: "x402" }),
    ).toThrow(/non-placeholder payTo/);
  });

  it("accepts a configured testnet payee in x402 mode", () => {
    expect(() =>
      assertSellerServerConfig({
        ...BASE_CONFIG,
        paymentMode: "x402",
        payToAddress: "0x3333333333333333333333333333333333333333",
      }),
    ).not.toThrow();
  });

  it("rejects the published purchase-context secret in x402 mode", () => {
    expect(() =>
      assertSellerServerConfig({
        ...BASE_CONFIG,
        paymentMode: "x402",
        payToAddress: "0x3333333333333333333333333333333333333333",
        purchaseContextHmacSecret:
          "change-me-with-at-least-32-random-characters",
      }),
    ).toThrow(/non-placeholder purchase-context HMAC secret/);
  });

  it("requires a non-trivial shared purchase-context secret", () => {
    expect(() =>
      assertSellerServerConfig({
        ...BASE_CONFIG,
        purchaseContextHmacSecret: "too-short",
      }),
    ).toThrow();
    expect(() =>
      assertSellerServerConfig({
        ...BASE_CONFIG,
        purchaseContextHmacSecret: "1234567890abcdef",
      }),
    ).toThrow();
  });

  it.each([
    ["network", { network: "eip155:1" }, /eip155:84532/],
    [
      "token address",
      { tokenAddress: "0x3333333333333333333333333333333333333333" },
      /Base Sepolia Test USDC address/,
    ],
    ["token decimals", { tokenDecimals: 18 }, /decimals=6/],
  ] as const)("rejects an x402 %s outside the fixed P0 asset", (_label, override, error) => {
    expect(() =>
      assertSellerServerConfig({
        ...BASE_CONFIG,
        paymentMode: "x402",
        payToAddress: "0x3333333333333333333333333333333333333333",
        ...override,
      }),
    ).toThrow(error);
  });

  it("keeps mock mode flexible for local protocol tests", () => {
    expect(() =>
      assertSellerServerConfig({
        ...BASE_CONFIG,
        network: "eip155:31337",
        tokenAddress: "0x3333333333333333333333333333333333333333",
        tokenDecimals: 18,
      }),
    ).not.toThrow();
  });
});
