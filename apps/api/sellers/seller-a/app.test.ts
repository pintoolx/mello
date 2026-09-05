import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  createPurchaseContextToken,
  IDEMPOTENCY_STATUS_HEADER,
  InMemoryIdempotencyStore,
  MOCK_PAYMENT_HEADER,
  MOCK_PAYMENT_HEADER_VALUE,
  MOCK_PAYMENT_ID_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
} from "@mello/seller-kit";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createSellerAApplication } from "./app.js";

const CONTEXT_SECRET = "0123456789abcdef0123456789abcdef";
const FIXED_NOW = new Date("2026-09-04T12:00:00.000Z");
const FIXED_NOW_SECONDS = Math.floor(FIXED_NOW.getTime() / 1_000);
const BODY = {
  targetCompanyName: "Example Co.",
  purchaseContextToken: createPurchaseContextToken(
    {
      purchaseId: "00000000-0000-4000-8000-000000000011",
      buyerProfileId: "00000000-0000-4000-8000-000000000001",
      sellerId: "seller-a",
    },
    CONTEXT_SECRET,
    FIXED_NOW_SECONDS,
  ),
};
const PAYMENT_ID = "pay_seller_a_test_000001";

function createTestApplication() {
  const idempotencyStore = new InMemoryIdempotencyStore(
    undefined,
    () => FIXED_NOW.getTime(),
  );
  return {
    ...createSellerAApplication(
      {
        paymentMode: "mock",
        clock: () => FIXED_NOW,
        purchaseContextHmacSecret: CONTEXT_SECRET,
      },
      { idempotencyStore },
    ),
    idempotencyStore,
  };
}

describe("seller-a", () => {
  it("reports health without exposing secrets", async () => {
    const { app } = createTestApplication();
    const response = await request(app).get("/health").expect(200);

    expect(response.body).toMatchObject({
      status: "ok",
      sellerId: "seller-a",
      paymentMode: "mock",
      invoiceCapability: "NONE",
      priceAtomic: "40000",
    });
    expect(JSON.stringify(response.body)).not.toMatch(/private|secret|key/i);
  });

  it("returns a standard x402 v2 402 with required payment-identifier", async () => {
    const { app } = createTestApplication();
    const response = await request(app)
      .post("/v1/credit-report")
      .send(BODY)
      .expect(402);

    const header = response.headers[PAYMENT_REQUIRED_HEADER];
    expect(header).toEqual(expect.any(String));
    const required = decodePaymentRequiredHeader(header as string);
    expect(required).toMatchObject({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:84532",
          amount: "40000",
          payTo: "0x1111111111111111111111111111111111111111",
          extra: {
            name: "USDC",
            version: "2",
            assetTransferMethod: "eip3009",
          },
        },
      ],
      extensions: {
        "payment-identifier": {
          info: { required: true },
        },
      },
    });
    expect(required.extensions).not.toHaveProperty("tw-einvoice");
  });

  it("requires an explicit valid mock payment identifier", async () => {
    const { app } = createTestApplication();
    const response = await request(app)
      .post("/v1/credit-report")
      .set(MOCK_PAYMENT_HEADER, MOCK_PAYMENT_HEADER_VALUE)
      .send(BODY)
      .expect(400);

    expect(response.body.error.code).toBe("PAYMENT_IDENTIFIER_REQUIRED");
  });

  it("serves and caches a deterministic report for the same payment fingerprint", async () => {
    const { app, idempotencyStore } = createTestApplication();
    const first = await request(app)
      .post("/v1/credit-report")
      .set(MOCK_PAYMENT_HEADER, MOCK_PAYMENT_HEADER_VALUE)
      .set(MOCK_PAYMENT_ID_HEADER, PAYMENT_ID)
      .send(BODY)
      .expect(200);

    expect(first.headers[IDEMPOTENCY_STATUS_HEADER]).toBe("miss");
    expect(first.body).toMatchObject({
      provider: "seller-a",
      targetCompanyName: "Example Co.",
      summary: "Demo credit report only",
      generatedAt: FIXED_NOW.toISOString(),
      paymentMode: "mock",
      isDemo: true,
    });
    const paymentResponse = decodePaymentResponseHeader(
      first.headers[PAYMENT_RESPONSE_HEADER] as string,
    );
    expect(paymentResponse).toMatchObject({
      success: true,
      network: "eip155:84532",
      amount: "40000",
      extra: { paymentMode: "mock", paymentId: PAYMENT_ID },
    });

    const retry = await request(app)
      .post("/v1/credit-report")
      .set(MOCK_PAYMENT_HEADER, MOCK_PAYMENT_HEADER_VALUE)
      .set(MOCK_PAYMENT_ID_HEADER, PAYMENT_ID)
      .send(BODY)
      .expect(200);

    expect(retry.headers[IDEMPOTENCY_STATUS_HEADER]).toBe("hit");
    expect(retry.body).toEqual(first.body);
    expect(idempotencyStore.size).toBe(1);
  });

  it("returns 409 when a payment identifier is reused for another fingerprint", async () => {
    const { app } = createTestApplication();
    await request(app)
      .post("/v1/credit-report")
      .set(MOCK_PAYMENT_HEADER, MOCK_PAYMENT_HEADER_VALUE)
      .set(MOCK_PAYMENT_ID_HEADER, PAYMENT_ID)
      .send(BODY)
      .expect(200);

    const conflict = await request(app)
      .post("/v1/credit-report")
      .set(MOCK_PAYMENT_HEADER, MOCK_PAYMENT_HEADER_VALUE)
      .set(MOCK_PAYMENT_ID_HEADER, PAYMENT_ID)
      .send({ ...BODY, targetCompanyName: "Different Co." })
      .expect(409);

    expect(conflict.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});
