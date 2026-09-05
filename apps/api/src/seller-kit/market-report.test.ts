import { describe, expect, it } from "vitest";
import request from "supertest";
import { MARKET_SERVICE_CATALOG } from "@mello/shared";
import { createSellerAApplication } from "../../sellers/seller-a/app.js";
import { createSellerBApplication } from "../../sellers/seller-b/app.js";
import { createPurchaseContextToken } from "./purchase-context.js";
import { InMemoryIdempotencyStore } from "./idempotency.js";
import { MOCK_PAYMENT_HEADER, MOCK_PAYMENT_HEADER_VALUE, MOCK_PAYMENT_ID_HEADER } from "./headers.js";
import { createDeterministicCreditReport, CreditReportSchema, MarketReportSchema, PublicCreditReportRequestSchema } from "./report.js";
import { PaymentSettlementReportSchema, reportMatchesRequest, reportRequestBody } from "../modules/x402-buyer/payment-provider.js";

const now = new Date("2026-09-06T00:00:00.000Z");
const secret = "market-report-test-secret-32-characters";

describe("versioned market reports (no external services)", () => {
  it.each(MARKET_SERVICE_CATALOG)("delivers $id without inventing an enterprise", (offering) => {
    const input = { serviceId: offering.id, serviceCategory: offering.category, serviceQuery: offering.displayName };
    const report = createDeterministicCreditReport(offering.sellerId, input, "mock", now);
    expect(MarketReportSchema.safeParse(report).success).toBe(true);
    expect(report).toMatchObject({ reportVersion: "market-v1", ...input, title: offering.displayName, isDemo: true });
    expect(report).not.toHaveProperty("targetCompanyName");
    expect(report).not.toHaveProperty("riskScore");
    expect(JSON.stringify(report)).not.toContain("Example Co.");
    expect(reportMatchesRequest(PaymentSettlementReportSchema.parse(report), { ...input, sellerId: offering.sellerId })).toBe(true);
    expect(createDeterministicCreditReport(offering.sellerId, input, "mock", now)).toEqual(report);
  });

  it("strictly separates modern and legacy requests and responses", () => {
    const legacy = createDeterministicCreditReport("seller-b", { targetCompanyName: "Actual supplied company" }, "mock", now);
    const binding = { sellerId: "seller-b", serviceId: "macro-analysis", serviceCategory: "macro_analysis" as const, serviceQuery: "總經分析" };
    expect(CreditReportSchema.safeParse(legacy).success).toBe(true);
    expect(reportMatchesRequest(PaymentSettlementReportSchema.parse(legacy), binding)).toBe(false);
    expect(PaymentSettlementReportSchema.safeParse({ ...legacy, reportVersion: "market-v1" }).success).toBe(false);
    expect(PaymentSettlementReportSchema.safeParse({ ...legacy, serviceId: "macro-analysis" }).success).toBe(false);
    expect(PublicCreditReportRequestSchema.safeParse({ ...binding, targetCompanyName: "Invented", sellerId: undefined }).success).toBe(false);
    expect(() => reportRequestBody({ ...binding, serviceQuery: undefined, purchaseContextToken: "context" })).toThrow();
    expect(reportRequestBody({ sellerId: "seller-b", targetCompanyName: "Old company", purchaseContextToken: "old-context" }))
      .toEqual({ targetCompanyName: "Old company", purchaseContextToken: "old-context" });
  });

  it.each(["serviceId", "serviceCategory", "serviceQuery", "provider"] as const)("rejects mismatched %s", (field) => {
    const input = { serviceId: "macro-analysis", serviceCategory: "macro_analysis" as const, serviceQuery: "總經分析" };
    const report = PaymentSettlementReportSchema.parse(createDeterministicCreditReport("seller-b", input, "mock", now));
    const wrong = { ...report, [field]: field === "serviceCategory" ? "crypto_market" : "different-value" };
    expect(reportMatchesRequest(wrong as typeof report, { ...input, sellerId: "seller-b" })).toBe(false);
  });

  it.each(MARKET_SERVICE_CATALOG)("serves and replays $id; a changed query conflicts", async (offering) => {
    const create = offering.sellerId === "seller-a" ? createSellerAApplication : createSellerBApplication;
    const { app } = create({ paymentMode: "mock", clock: () => now, purchaseContextHmacSecret: secret }, { idempotencyStore: new InMemoryIdempotencyStore() });
    const purchaseContextToken = createPurchaseContextToken({ purchaseId: "00000000-0000-4000-8000-000000000012", buyerProfileId: "00000000-0000-4000-8000-000000000001", sellerId: offering.sellerId }, secret, now.getTime() / 1000);
    const body = { serviceId: offering.id, serviceCategory: offering.category, serviceQuery: String(offering.displayName), purchaseContextToken };
    const call = (input = body) => request(app).post("/v1/credit-report").set(MOCK_PAYMENT_HEADER, MOCK_PAYMENT_HEADER_VALUE).set(MOCK_PAYMENT_ID_HEADER, "pay_market_report_test_00001").send(input);
    const first = await call().expect(200);
    const replay = await call().expect(200);
    expect(replay.body).toEqual(first.body);
    expect(first.body).toMatchObject({ reportVersion: "market-v1", provider: offering.sellerId, serviceId: offering.id });
    await call({ ...body, serviceQuery: "Changed subject" }).expect(409);
  });

  it("rejects another seller's offering before mock settlement", async () => {
    const store = new InMemoryIdempotencyStore();
    const { app } = createSellerAApplication({ paymentMode: "mock", clock: () => now, purchaseContextHmacSecret: secret }, { idempotencyStore: store });
    const purchaseContextToken = createPurchaseContextToken({ purchaseId: "00000000-0000-4000-8000-000000000012", buyerProfileId: "00000000-0000-4000-8000-000000000001", sellerId: "seller-a" }, secret, now.getTime() / 1000);
    await request(app).post("/v1/credit-report").set(MOCK_PAYMENT_HEADER, MOCK_PAYMENT_HEADER_VALUE).set(MOCK_PAYMENT_ID_HEADER, "pay_market_wrong_seller_0001")
      .send({ serviceId: "macro-analysis", serviceCategory: "macro_analysis", serviceQuery: "總經分析", purchaseContextToken }).expect(400);
    expect(store.size).toBe(0);
  });

  it("keeps a cached legacy delivery byte-shape intact across modern requests", async () => {
    const { app } = createSellerAApplication({ paymentMode: "mock", clock: () => now, purchaseContextHmacSecret: secret }, { idempotencyStore: new InMemoryIdempotencyStore() });
    const purchaseContextToken = createPurchaseContextToken({ purchaseId: "00000000-0000-4000-8000-000000000012", buyerProfileId: "00000000-0000-4000-8000-000000000001", sellerId: "seller-a" }, secret, now.getTime() / 1000);
    const legacy = { targetCompanyName: "Original company", purchaseContextToken };
    const call = (body: object) => request(app).post("/v1/credit-report").set(MOCK_PAYMENT_HEADER, MOCK_PAYMENT_HEADER_VALUE).set(MOCK_PAYMENT_ID_HEADER, "pay_legacy_cache_keep_00001").send(body);
    const before = await call(legacy).expect(200);
    await call({ serviceId: "stock-analysis", serviceCategory: "stock_analysis", serviceQuery: "個股分析", purchaseContextToken }).expect(409);
    const after = await call(legacy).expect(200);
    expect(after.text).toEqual(before.text);
    expect(after.body).not.toHaveProperty("reportVersion");
    expect(after.body).toMatchObject({ targetCompanyName: "Original company", summary: "Demo credit report only" });
  });
});
