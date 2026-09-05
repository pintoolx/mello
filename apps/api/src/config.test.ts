import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { readFileSync } from "node:fs";
import { parse } from "dotenv";

const DATABASE_URL = "postgresql://mello:mello@localhost:5432/mello_test";

describe("Core API feature boundaries", () => {
  it("defaults to first-attempt Demo invoice success, including the published environment template", () => {
    expect(loadConfig({ DATABASE_URL }).MOCK_INVOICE_FAIL_ONCE).toBe(false);
    const template = parse(readFileSync(new URL("../.env.example", import.meta.url)));
    expect(template["MOCK_INVOICE_FAIL_ONCE"]).toBe("false");
    expect(loadConfig({ DATABASE_URL, MOCK_INVOICE_FAIL_ONCE: template["MOCK_INVOICE_FAIL_ONCE"] }).MOCK_INVOICE_FAIL_ONCE).toBe(false);
  });

  it("retains explicitly requested invoice-recovery fault injection", () => {
    expect(loadConfig({ DATABASE_URL, MOCK_INVOICE_FAIL_ONCE: "true" }).MOCK_INVOICE_FAIL_ONCE).toBe(true);
    expect(loadConfig({ DATABASE_URL, MOCK_INVOICE_FAIL_ONCE: "false" }).MOCK_INVOICE_FAIL_ONCE).toBe(false);
  });

  it("keeps roadmap Ethereum adapters disabled by default", () => {
    expect(loadConfig({ DATABASE_URL })).toMatchObject({
      ERC8004_IDENTITY_ENABLED: false,
      ERC8004_REPUTATION_ENABLED: false,
      ERC8196_WALLET_ENABLED: false,
    });
  });

  it.each([
    "ERC8004_IDENTITY_ENABLED",
    "ERC8004_REPUTATION_ENABLED",
    "ERC8196_WALLET_ENABLED",
  ] as const)("fails fast instead of pretending %s is active", (feature) => {
    expect(() => loadConfig({ DATABASE_URL, [feature]: "true" })).toThrow(
      "not implemented in this P0 build",
    );
  });

  it("rejects the published purchase-context secret in x402 mode", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL,
        PAYMENT_MODE: "x402",
        EVM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
      }),
    ).toThrow("A non-placeholder SELLER_CONTEXT_HMAC_SECRET is required");
  });

  it("accepts an explicit purchase-context secret in x402 mode", () => {
    expect(
      loadConfig({
        DATABASE_URL,
        PAYMENT_MODE: "x402",
        EVM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
        SELLER_CONTEXT_HMAC_SECRET: "integration-only-secret-32-bytes-long",
      }).PAYMENT_MODE,
    ).toBe("x402");
  });

  it("rejects purchase-context HMAC secrets shorter than 32 characters", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL,
        SELLER_CONTEXT_HMAC_SECRET: "1234567890abcdef",
      }),
    ).toThrow();
  });

  it.each([
    ["USDC_TOKEN_ADDRESS", "0x3333333333333333333333333333333333333333", "Base Sepolia Test USDC address"],
    ["USDC_TOKEN_DECIMALS", "18", "decimals=6"],
  ] as const)("rejects an x402 %s outside the fixed P0 asset", (key, value, message) => {
    expect(() =>
      loadConfig({
        DATABASE_URL,
        PAYMENT_MODE: "x402",
        EVM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
        SELLER_CONTEXT_HMAC_SECRET: "integration-only-secret-32-bytes-long",
        [key]: value,
      }),
    ).toThrow(message);
  });

  it("rejects an x402 network other than the fixed Base Sepolia CAIP-2 id", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL,
        PAYMENT_MODE: "x402",
        X402_NETWORK: "eip155:1",
        EVM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
        SELLER_CONTEXT_HMAC_SECRET: "integration-only-secret-32-bytes-long",
      }),
    ).toThrow();
  });

  it("fails fast instead of silently disabling mandatory ERC-3009 evidence", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL,
        ERC3009_RECORDING_ENABLED: "false",
      }),
    ).toThrow("authorization evidence is mandatory");
  });

  it("caps durable workflow execution attempts at three", () => {
    expect(loadConfig({ DATABASE_URL }).WORKFLOW_MAX_ATTEMPTS).toBe(3);
    expect(() =>
      loadConfig({ DATABASE_URL, WORKFLOW_MAX_ATTEMPTS: "4" }),
    ).toThrow();
  });

  it.each(["SELLER_A_PAY_TO", "SELLER_B_PAY_TO"] as const)(
    "rejects %s when it points at the audit registry",
    (sellerField) => {
      const registryAddress = "0x3333333333333333333333333333333333333333";

      expect(() =>
        loadConfig({
          DATABASE_URL,
          PAYMENT_MODE: "x402",
          EVM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
          SELLER_CONTEXT_HMAC_SECRET: "integration-only-secret-32-bytes-long",
          CONTRACT_ANCHOR_MODE: "onchain",
          CONTRACT_OPERATOR_PRIVATE_KEY: `0x${"2".repeat(64)}`,
          AUDIT_REGISTRY_ADDRESS: registryAddress,
          [sellerField]: registryAddress,
        }),
      ).toThrow("audit contract must never receive payment funds");
    },
  );
});
