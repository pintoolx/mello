import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createPaymentRequirements,
  createPurchaseContextToken,
  createSellerServiceLogger,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  IDEMPOTENCY_STATUS_HEADER,
  InMemoryIdempotencyStore,
  PAYMENT_RESPONSE_HEADER,
  type SellerIdempotencyStore,
} from "@mello/seller-kit";
import { TW_EINVOICE_EXTENSION_KEY } from "@mello/tw-einvoice-extension";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createSellerBApplication } from "./app.js";

const CONTEXT_SECRET = "0123456789abcdef0123456789abcdef";
const PAYMENT_ID = "pay_real_cache_test_000001";
const FIXED_NOW = new Date("2026-09-04T12:00:00.000Z");
const PAYER = "0x4444444444444444444444444444444444444444";
const PAY_TO = "0x3333333333333333333333333333333333333333";

function sendJson(response: ServerResponse, body: unknown): void {
  response.statusCode = 200;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

describe("seller-b real x402 idempotency", () => {
  it("replays the identical enriched PAYMENT-RESPONSE without settling twice", async () => {
    const calls = { supported: 0, verify: 0, settle: 0 };
    const facilitator = createServer((incoming, response) => {
      incoming.resume();
      if (incoming.method === "GET" && incoming.url === "/supported") {
        calls.supported += 1;
        sendJson(response, {
          kinds: [
            {
              x402Version: 2,
              scheme: "exact",
              network: "eip155:84532",
            },
          ],
          extensions: ["payment-identifier", TW_EINVOICE_EXTENSION_KEY],
          signers: {},
        });
        return;
      }
      if (incoming.method === "POST" && incoming.url === "/verify") {
        calls.verify += 1;
        sendJson(response, { isValid: true, payer: PAYER });
        return;
      }
      if (incoming.method === "POST" && incoming.url === "/settle") {
        calls.settle += 1;
        sendJson(response, {
          success: true,
          payer: PAYER,
          transaction: `0x${"ab".repeat(32)}`,
          network: "eip155:84532",
          amount: "50000",
        });
        return;
      }
      response.statusCode = 404;
      response.end();
    });

    await new Promise<void>((resolve, reject) => {
      facilitator.once("error", reject);
      facilitator.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = facilitator.address() as AddressInfo;
      const application = createSellerBApplication(
        {
          paymentMode: "x402",
          payToAddress: PAY_TO,
          facilitatorUrl: `http://127.0.0.1:${address.port}`,
          purchaseContextHmacSecret: CONTEXT_SECRET,
          clock: () => FIXED_NOW,
        },
        {
          idempotencyStore: new InMemoryIdempotencyStore(
            undefined,
            () => FIXED_NOW.getTime(),
          ),
          idempotencyWaitTimeoutMs: 2_000,
          idempotencyPollIntervalMs: 5,
        },
      );
      const body = {
        targetCompanyName: "Example Co.",
        purchaseContextToken: createPurchaseContextToken(
          {
            purchaseId: "00000000-0000-4000-8000-000000000020",
            buyerProfileId: "00000000-0000-4000-8000-000000000001",
            sellerId: "seller-b",
          },
          CONTEXT_SECRET,
          Math.floor(FIXED_NOW.getTime() / 1_000),
        ),
      };
      const requirements = createPaymentRequirements(application.config);
      const paymentPayload: Parameters<
        typeof encodePaymentSignatureHeader
      >[0] = {
        x402Version: 2,
        accepted: requirements,
        payload: {
          signature: `0x${"cd".repeat(65)}`,
          authorization: {
            from: PAYER,
            to: PAY_TO,
            value: requirements.amount,
            validAfter: "0",
            validBefore: String(
              Math.floor(FIXED_NOW.getTime() / 1_000) + 300,
            ),
            nonce: `0x${"ef".repeat(32)}`,
          },
        },
        extensions: {
          "payment-identifier": {
            info: { required: true, id: PAYMENT_ID },
          },
        },
      };
      const paymentSignature = encodePaymentSignatureHeader(paymentPayload);

      const [firstAttempt, concurrentAttempt] = await Promise.all([
        request(application.app)
          .post("/v1/credit-report")
          .set("payment-signature", paymentSignature)
          .send(body),
        request(application.app)
          .post("/v1/credit-report")
          .set("payment-signature", paymentSignature)
          .send(body),
      ]);
      const concurrentResults = {
        first: { status: firstAttempt.status, body: firstAttempt.body },
        concurrent: {
          status: concurrentAttempt.status,
          body: concurrentAttempt.body,
        },
      };
      if (firstAttempt.status !== 200 || concurrentAttempt.status !== 200) {
        throw new Error(JSON.stringify({ concurrentResults, calls }));
      }
      expect(concurrentResults).toMatchObject({
        first: { status: 200 },
        concurrent: { status: 200 },
      });
      const first =
        firstAttempt.headers[IDEMPOTENCY_STATUS_HEADER] === "miss"
          ? firstAttempt
          : concurrentAttempt;
      const concurrentRetry =
        first === firstAttempt ? concurrentAttempt : firstAttempt;

      const firstSettlementHeader = first.headers[
        PAYMENT_RESPONSE_HEADER
      ] as string;
      expect(first.headers[IDEMPOTENCY_STATUS_HEADER]).toBe("miss");
      expect(concurrentRetry.headers[IDEMPOTENCY_STATUS_HEADER]).toBe("hit");
      expect(concurrentRetry.headers[PAYMENT_RESPONSE_HEADER]).toBe(
        firstSettlementHeader,
      );
      expect(concurrentRetry.body).toEqual(first.body);
      expect(decodePaymentResponseHeader(firstSettlementHeader)).toMatchObject({
        success: true,
        transaction: `0x${"ab".repeat(32)}`,
        network: "eip155:84532",
        amount: "50000",
        extensions: {
          [TW_EINVOICE_EXTENSION_KEY]: {
            accepted: true,
            sellerProfileId: "seller-b",
            invoiceStatus: "READY_FOR_ORCHESTRATION",
          },
        },
      });

      const retry = await request(application.app)
        .post("/v1/credit-report")
        .set("payment-signature", paymentSignature)
        .send(body)
        .expect(200);

      expect(retry.headers[IDEMPOTENCY_STATUS_HEADER]).toBe("hit");
      expect(retry.headers[PAYMENT_RESPONSE_HEADER]).toBe(firstSettlementHeader);
      expect(decodePaymentResponseHeader(retry.headers[PAYMENT_RESPONSE_HEADER] as string))
        .toMatchObject({ success: true, transaction: `0x${"ab".repeat(32)}` });
      expect(retry.body).toEqual(first.body);
      expect(calls).toEqual({ supported: 1, verify: 1, settle: 1 });

      const forgedPayload = structuredClone(paymentPayload);
      forgedPayload.payload = {
        ...forgedPayload.payload,
        signature: `0x${"01".repeat(65)}`,
      };
      await request(application.app)
        .post("/v1/credit-report")
        .set(
          "payment-signature",
          encodePaymentSignatureHeader(forgedPayload),
        )
        .send(body)
        .expect(409);
      expect(calls).toEqual({ supported: 1, verify: 1, settle: 1 });
    } finally {
      await new Promise<void>((resolve, reject) => {
        facilitator.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("keeps a permanent fence when response-cache completion fails", async () => {
    const calls = { supported: 0, verify: 0, settle: 0 };
    const logLines: string[] = [];
    const facilitator = createServer((incoming, response) => {
      incoming.resume();
      if (incoming.method === "GET" && incoming.url === "/supported") {
        calls.supported += 1;
        sendJson(response, {
          kinds: [
            {
              x402Version: 2,
              scheme: "exact",
              network: "eip155:84532",
            },
          ],
          extensions: ["payment-identifier", TW_EINVOICE_EXTENSION_KEY],
          signers: {},
        });
        return;
      }
      if (incoming.method === "POST" && incoming.url === "/verify") {
        calls.verify += 1;
        sendJson(response, { isValid: true, payer: PAYER });
        return;
      }
      if (incoming.method === "POST" && incoming.url === "/settle") {
        calls.settle += 1;
        sendJson(response, {
          success: true,
          payer: PAYER,
          transaction: `0x${"bc".repeat(32)}`,
          network: "eip155:84532",
          amount: "50000",
        });
        return;
      }
      response.statusCode = 404;
      response.end();
    });

    await new Promise<void>((resolve, reject) => {
      facilitator.once("error", reject);
      facilitator.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = facilitator.address() as AddressInfo;
      let now = FIXED_NOW.getTime();
      const backingStore = new InMemoryIdempotencyStore(
        undefined,
        () => now,
        10,
      );
      const completionFaultStore = {
        claim: (...args) => backingStore.claim(...args),
        lookup: (...args) => backingStore.lookup(...args),
        beginSettlement: (...args) => backingStore.beginSettlement(...args),
        complete: async () => {
          throw new Error("simulated durable completion outage");
        },
      } satisfies SellerIdempotencyStore;
      const application = createSellerBApplication(
        {
          paymentMode: "x402",
          payToAddress: PAY_TO,
          facilitatorUrl: `http://127.0.0.1:${address.port}`,
          purchaseContextHmacSecret: CONTEXT_SECRET,
          clock: () => new Date(now),
        },
        {
          idempotencyStore: completionFaultStore,
          idempotencyWaitTimeoutMs: 25,
          idempotencyPollIntervalMs: 5,
          logger: createSellerServiceLogger(
            "seller-b",
            (line) => logLines.push(line),
            () => new Date(now),
          ),
        },
      );
      const body = {
        targetCompanyName: "Completion Fault Co.",
        purchaseContextToken: createPurchaseContextToken(
          {
            purchaseId: "00000000-0000-4000-8000-000000000021",
            buyerProfileId: "00000000-0000-4000-8000-000000000001",
            sellerId: "seller-b",
          },
          CONTEXT_SECRET,
          Math.floor(now / 1_000),
        ),
      };
      const requirements = createPaymentRequirements(application.config);
      const paymentPayload: Parameters<typeof encodePaymentSignatureHeader>[0] = {
        x402Version: 2,
        accepted: requirements,
        payload: {
          signature: `0x${"de".repeat(65)}`,
          authorization: {
            from: PAYER,
            to: PAY_TO,
            value: requirements.amount,
            validAfter: "0",
            validBefore: String(Math.floor(now / 1_000) + 300),
            nonce: `0x${"fa".repeat(32)}`,
          },
        },
        extensions: {
          "payment-identifier": {
            info: { required: true, id: "pay_completion_fault_000001" },
          },
        },
      };
      const paymentSignature = encodePaymentSignatureHeader(paymentPayload);

      const first = await request(application.app)
        .post("/v1/credit-report")
        .set("x-request-id", "request-completion-fault")
        .set("x-mello-task-id", "00000000-0000-4000-8000-000000000101")
        .set("payment-signature", paymentSignature)
        .send(body)
        .expect(200);
      expect(first.headers[IDEMPOTENCY_STATUS_HEADER]).toBe("miss");
      expect(calls).toEqual({ supported: 1, verify: 1, settle: 1 });
      expect(logLines).toHaveLength(1);
      expect(JSON.parse(logLines[0] ?? "")).toMatchObject({
        requestId: "request-completion-fault",
        taskId: "00000000-0000-4000-8000-000000000101",
        purchaseId: "00000000-0000-4000-8000-000000000021",
        paymentId: "pay_completion_fault_000001",
        sellerId: "seller-b",
        stage: "IDEMPOTENCY_COMPLETION",
        message: "Failed to persist seller payment cache completion",
        details: {
          errorName: "Error",
          errorMessage: "simulated durable completion outage",
          settlementMayHaveSucceeded: true,
          automaticResettlementAllowed: false,
        },
      });

      now += 60_000;
      const retry = await request(application.app)
        .post("/v1/credit-report")
        .set("payment-signature", paymentSignature)
        .send(body)
        .expect(425);
      expect(retry.body).toMatchObject({
        error: { code: "IDEMPOTENCY_IN_PROGRESS", retryable: true },
      });
      expect(calls).toEqual({ supported: 1, verify: 1, settle: 1 });
    } finally {
      await new Promise<void>((resolve, reject) => {
        facilitator.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
