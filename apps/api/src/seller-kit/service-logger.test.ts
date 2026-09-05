import { describe, expect, it } from "vitest";
import { createSellerServiceLogger } from "./service-logger.js";

const FIXED_NOW = new Date("2026-09-05T01:02:03.000Z");

describe("seller service logger", () => {
  it("emits the complete correlation contract and redacts sensitive details", () => {
    const lines: string[] = [];
    const logger = createSellerServiceLogger(
      "seller-a",
      (line) => lines.push(line),
      () => FIXED_NOW,
    );

    logger.error(
      {
        requestId: "request-123",
        purchaseId: "purchase-123",
        paymentId: "payment-123",
        sellerId: "seller-b",
        stage: "SETTLEMENT_FENCE",
      },
      "Settlement failed with Bearer unsafe-token",
      {
        errorMessage:
          "postgresql://user:database-password@localhost:5432/mello " +
          "https://api.example.invalid/pay?api_key=URL_API_KEY_SENTINEL",
        nested: {
          authorization: "Bearer nested-secret",
          privateKey: "0xprivate-secret",
          signature: `0x${"ab".repeat(65)}`,
        },
      },
    );

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: "error",
      time: FIXED_NOW.toISOString(),
      service: "mello-seller",
      requestId: "request-123",
      taskId: null,
      purchaseId: "purchase-123",
      paymentId: "payment-123",
      sellerId: "seller-b",
      stage: "SETTLEMENT_FENCE",
      message: "Settlement failed with [REDACTED]",
    });
    expect(lines[0]).toContain("[REDACTED]");
    for (const secret of [
      "unsafe-token",
      "database-password",
      "URL_API_KEY_SENTINEL",
      "nested-secret",
      "0xprivate-secret",
      `0x${"ab".repeat(65)}`,
    ]) {
      expect(lines[0]).not.toContain(secret);
    }
  });

  it("uses null for unknown context and the configured seller baseline", () => {
    const lines: string[] = [];
    const logger = createSellerServiceLogger(
      "seller-a",
      (line) => lines.push(line),
      () => FIXED_NOW,
    );

    logger.error({}, "Service failure");

    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      requestId: null,
      taskId: null,
      purchaseId: null,
      paymentId: null,
      sellerId: "seller-a",
      stage: null,
    });
  });

  it("emits startup as structured info with the complete null-safe context", () => {
    const lines: string[] = [];
    const logger = createSellerServiceLogger(
      "seller-b",
      (line) => lines.push(line),
      () => FIXED_NOW,
    );

    logger.info(
      { sellerId: "seller-b", stage: "STARTUP" },
      "Seller service listening",
      { port: 4_012, paymentMode: "x402" },
    );

    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      level: "info",
      requestId: null,
      taskId: null,
      purchaseId: null,
      paymentId: null,
      sellerId: "seller-b",
      stage: "STARTUP",
      message: "Seller service listening",
      details: { port: 4_012, paymentMode: "x402" },
    });
  });
});
