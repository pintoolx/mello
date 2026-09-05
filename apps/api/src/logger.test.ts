import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

describe("secret redaction", () => {
  it("does not emit signature or private-key material", () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const testLogger = createLogger(destination);
    testLogger.info({
      privateKey: "0xsecret",
      signature: "0xsig",
      OPENAI_API_KEY: "sk-x",
      config: {
        EVM_PRIVATE_KEY: "0xbuyer-secret",
        CONTRACT_OPERATOR_PRIVATE_KEY: "0xoperator-secret",
        SELLER_CONTEXT_HMAC_SECRET: "hmac-secret",
        ECPAY_STAGE_HASH_KEY: "invoice-key",
        ECPAY_STAGE_HASH_IV: "invoice-iv",
      },
      req: {
        headers: {
          authorization: "Bearer secret",
          "x-demo-admin-token": "admin-secret",
          "payment-signature": "signed-payment-secret",
        },
      },
    });
    expect(output).toContain("[REDACTED]");
    for (const secret of [
      "0xsecret",
      "0xsig",
      "sk-x",
      "0xbuyer-secret",
      "0xoperator-secret",
      "hmac-secret",
      "invoice-key",
      "invoice-iv",
      "Bearer secret",
      "admin-secret",
      "signed-payment-secret",
    ]) {
      expect(output).not.toContain(secret);
    }
  });

  it("always emits the complete correlation baseline and lets actual context override null", () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const testLogger = createLogger(destination);

    testLogger.info(
      { requestId: "request-123", taskId: "task-123", stage: "HTTP" },
      "context test",
    );

    const entry = JSON.parse(output) as Record<string, unknown>;
    expect(entry).toMatchObject({
      service: "mello-core-api",
      requestId: "request-123",
      taskId: "task-123",
      purchaseId: null,
      paymentId: null,
      sellerId: null,
      stage: "HTTP",
    });
  });

  it("redacts secrets embedded in exception messages and stacks", () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const testLogger = createLogger(destination);
    const privateKey = `0x${"ab".repeat(32)}`;
    const error = new Error(
      `upstream https://api.example.invalid/pay?api_key=URL_API_KEY_SENTINEL ` +
        `postgresql://mello:DB_SENTINEL@localhost:5432/mello ` +
        `Bearer BEARER_SENTINEL ${privateKey}`,
    );

    testLogger.error({ err: error, stage: "HTTP" }, "probe");

    const entry = JSON.parse(output) as { err: { message: string; stack: string } };
    expect(entry.err.message).toContain("[REDACTED]");
    for (const secret of [
      "URL_API_KEY_SENTINEL",
      "DB_SENTINEL",
      "BEARER_SENTINEL",
      privateKey,
    ]) {
      expect(output).not.toContain(secret);
    }
  });
});
