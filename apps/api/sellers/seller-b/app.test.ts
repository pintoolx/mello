import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  createPurchaseContextToken,
  createSellerServiceLogger,
  IDEMPOTENCY_STATUS_HEADER,
  InMemoryIdempotencyStore,
  MOCK_PAYMENT_HEADER,
  MOCK_PAYMENT_HEADER_VALUE,
  MOCK_PAYMENT_ID_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  type SellerIdempotencyStore,
} from "@mello/seller-kit";
import { TW_EINVOICE_EXTENSION_KEY } from "@mello/tw-einvoice-extension";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createSellerBApplication } from "./app.js";

const CONTEXT_SECRET = "0123456789abcdef0123456789abcdef";
const FIXED_NOW = new Date("2026-09-04T12:00:00.000Z");
const FIXED_NOW_SECONDS = Math.floor(FIXED_NOW.getTime() / 1_000);
const BODY = {
  targetCompanyName: "Example Co.",
  purchaseContextToken: createPurchaseContextToken(
    {
      purchaseId: "00000000-0000-4000-8000-000000000012",
      buyerProfileId: "00000000-0000-4000-8000-000000000001",
      sellerId: "seller-b",
    },
    CONTEXT_SECRET,
    FIXED_NOW_SECONDS,
  ),
};
const PAYMENT_ID = "pay_seller_b_test_000001";

function createTestApplication() {
  const idempotencyStore = new InMemoryIdempotencyStore(
    undefined,
    () => FIXED_NOW.getTime(),
  );
  return {
    ...createSellerBApplication(
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

describe("seller-b", () => {
  it("reports its invoice capability on health", async () => {
    const { app } = createTestApplication();
    const response = await request(app).get("/health").expect(200);

    expect(response.body).toMatchObject({
      status: "ok",
      sellerId: "seller-b",
      paymentMode: "mock",
      invoiceCapability: "TW_B2B_DEMO",
      priceAtomic: "50000",
    });
  });

  it("returns a generic 500 and logs a redacted structured error", async () => {
    const privateKey = `0x${"ab".repeat(32)}`;
    const secretError =
      "database postgresql://mello:DB_SENTINEL@localhost:5432/mello " +
      "upstream https://api.example.invalid?api_key=URL_API_KEY_SENTINEL " +
      `Bearer BEARER_SENTINEL ${privateKey}`;
    const backingStore = new InMemoryIdempotencyStore(
      undefined,
      () => FIXED_NOW.getTime(),
    );
    const failingStore = {
      claim: async () => {
        throw new Error(secretError);
      },
      lookup: (...args) => backingStore.lookup(...args),
      beginSettlement: (...args) => backingStore.beginSettlement(...args),
      complete: (...args) => backingStore.complete(...args),
    } satisfies SellerIdempotencyStore;
    const logLines: string[] = [];
    const { app } = createSellerBApplication(
      {
        paymentMode: "mock",
        clock: () => FIXED_NOW,
        purchaseContextHmacSecret: CONTEXT_SECRET,
      },
      {
        idempotencyStore: failingStore,
        logger: createSellerServiceLogger(
          "seller-b",
          (line) => logLines.push(line),
          () => FIXED_NOW,
        ),
      },
    );

    const response = await request(app)
      .post("/v1/credit-report")
      .set("x-request-id", "seller-request-500")
      .set("x-mello-task-id", "00000000-0000-4000-8000-000000000101")
      .set(MOCK_PAYMENT_HEADER, MOCK_PAYMENT_HEADER_VALUE)
      .set(MOCK_PAYMENT_ID_HEADER, PAYMENT_ID)
      .send(BODY)
      .expect(500);

    expect(response.body).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unexpected server error",
        retryable: false,
      },
    });
    expect(logLines).toHaveLength(1);
    expect(JSON.parse(logLines[0] ?? "")).toMatchObject({
      requestId: "seller-request-500",
      taskId: "00000000-0000-4000-8000-000000000101",
      purchaseId: "00000000-0000-4000-8000-000000000012",
      paymentId: PAYMENT_ID,
      sellerId: "seller-b",
      stage: "HTTP",
      message: "Unhandled seller API error",
    });
    for (const secret of [
      "DB_SENTINEL",
      "URL_API_KEY_SENTINEL",
      "BEARER_SENTINEL",
      privateKey,
    ]) {
      expect(JSON.stringify(response.body)).not.toContain(secret);
      expect(logLines[0]).not.toContain(secret);
    }

    await request(app)
      .post("/v1/credit-report")
      .set("x-request-id", "seller-request-invalid-task")
      .set("x-mello-task-id", "not-a-task-id")
      .set(
        "x-mello-internal-task-id",
        "00000000-0000-4000-8000-000000000999",
      )
      .set(MOCK_PAYMENT_HEADER, MOCK_PAYMENT_HEADER_VALUE)
      .set(MOCK_PAYMENT_ID_HEADER, PAYMENT_ID)
      .send(BODY)
      .expect(500);
    expect(JSON.parse(logLines[1] ?? "")).toMatchObject({
      requestId: "seller-request-invalid-task",
      taskId: null,
      purchaseId: "00000000-0000-4000-8000-000000000012",
      sellerId: "seller-b",
      stage: "HTTP",
    });
  });

  it("advertises required payment-identifier and tw-einvoice v0.1 in its 402", async () => {
    const { app } = createTestApplication();
    const response = await request(app)
      .post("/v1/credit-report")
      .send(BODY)
      .expect(402);

    const required = decodePaymentRequiredHeader(
      response.headers[PAYMENT_REQUIRED_HEADER] as string,
    );
    expect(required.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "eip155:84532",
      amount: "50000",
      payTo: "0x2222222222222222222222222222222222222222",
      extra: {
        name: "USDC",
        version: "2",
        assetTransferMethod: "eip3009",
      },
    });
    expect(required.extensions?.["payment-identifier"]).toMatchObject({
      info: { required: true },
    });
    expect(required.extensions?.[TW_EINVOICE_EXTENSION_KEY]).toEqual({
      version: "0.1",
      jurisdiction: "TW",
      mode: "B2B_DEMO",
      sellerProfileId: "seller-b",
      provider: "mock",
      priceIncludesTax: true,
      requiredContext: ["purchaseContextToken"],
      supports: { void: false, allowance: false, aggregation: false },
    });
  });

  it("returns tw-einvoice settlement metadata and caches the paid response", async () => {
    const { app, idempotencyStore } = createTestApplication();
    const first = await request(app)
      .post("/v1/credit-report")
      .set(MOCK_PAYMENT_HEADER, MOCK_PAYMENT_HEADER_VALUE)
      .set(MOCK_PAYMENT_ID_HEADER, PAYMENT_ID)
      .send(BODY)
      .expect(200);

    expect(first.headers[IDEMPOTENCY_STATUS_HEADER]).toBe("miss");
    expect(first.body).toMatchObject({
      provider: "seller-b",
      targetCompanyName: "Example Co.",
      paymentMode: "mock",
      isDemo: true,
    });
    const settlement = decodePaymentResponseHeader(
      first.headers[PAYMENT_RESPONSE_HEADER] as string,
    );
    expect(settlement.extensions?.[TW_EINVOICE_EXTENSION_KEY]).toEqual({
      accepted: true,
      sellerProfileId: "seller-b",
      invoiceMode: "B2B_DEMO",
      invoiceStatus: "READY_FOR_ORCHESTRATION",
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

  it("rejects the same payment identifier when the request body changes", async () => {
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
      .send({
        ...BODY,
        purchaseContextToken: createPurchaseContextToken(
          {
            purchaseId: "00000000-0000-4000-8000-000000000013",
            buyerProfileId: "00000000-0000-4000-8000-000000000001",
            sellerId: "seller-b",
          },
          CONTEXT_SECRET,
          FIXED_NOW_SECONDS,
        ),
      })
      .expect(409);
    expect(conflict.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("treats taskId as correlation only and never as purchase authorization", async () => {
    const { app } = createTestApplication();
    const correlationTaskId = "00000000-0000-4000-8000-000000000999";

    await request(app)
      .post("/v1/credit-report")
      .set("x-mello-task-id", correlationTaskId)
      .send(BODY)
      .expect(402);

    const wrongSellerToken = createPurchaseContextToken(
      {
        purchaseId: "00000000-0000-4000-8000-000000000016",
        buyerProfileId: "00000000-0000-4000-8000-000000000001",
        sellerId: "seller-a",
      },
      CONTEXT_SECRET,
      FIXED_NOW_SECONDS,
    );
    await request(app)
      .post("/v1/credit-report")
      .set("x-mello-task-id", correlationTaskId)
      .send({ ...BODY, purchaseContextToken: wrongSellerToken })
      .expect(401);
  });

  it.each([
    ["forged", `${BODY.purchaseContextToken}x`],
    [
      "expired",
      createPurchaseContextToken(
        {
          purchaseId: "00000000-0000-4000-8000-000000000014",
          buyerProfileId: "00000000-0000-4000-8000-000000000001",
          sellerId: "seller-b",
        },
        CONTEXT_SECRET,
        FIXED_NOW_SECONDS - 600,
      ),
    ],
    [
      "wrong-seller",
      createPurchaseContextToken(
        {
          purchaseId: "00000000-0000-4000-8000-000000000015",
          buyerProfileId: "00000000-0000-4000-8000-000000000001",
          sellerId: "seller-a",
        },
        CONTEXT_SECRET,
        FIXED_NOW_SECONDS,
      ),
    ],
  ])("rejects a %s purchase context before asking for payment", async (_case, token) => {
    const { app, idempotencyStore } = createTestApplication();
    const response = await request(app)
      .post("/v1/credit-report")
      .send({ ...BODY, purchaseContextToken: token })
      .expect(401);

    expect(response.body.error).toMatchObject({
      code: "INVALID_PURCHASE_CONTEXT",
      retryable: false,
    });
    expect(response.headers[PAYMENT_REQUIRED_HEADER]).toBeUndefined();
    expect(idempotencyStore.size).toBe(0);
  });
});
