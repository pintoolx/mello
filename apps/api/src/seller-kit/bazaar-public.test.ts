import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createSellerBApplication } from "../../sellers/seller-b/app.js";
import { createPaymentRequirements, decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "./protocol.js";
import { InMemoryIdempotencyStore } from "./idempotency.js";
import { PAYMENT_REQUIRED_HEADER } from "./headers.js";
import { validateDiscoveryExtension } from "@x402/extensions/bazaar";

describe("public Bazaar seller protocol (fixture facilitator, no chain funds)", () => {
  let facilitator: Server;
  let facilitatorUrl: string;
  let verifies = 0;
  let settles = 0;
  const payer = "0x4444444444444444444444444444444444444444";
  beforeAll(async () => {
    facilitator = createServer((req, res) => {
      req.resume();
      res.setHeader("content-type", "application/json");
      if (req.url === "/supported") res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: ["bazaar", "payment-identifier", "tw-einvoice"], signers: {} }));
      else if (req.url === "/verify") { verifies++; res.end(JSON.stringify({ isValid: true, payer })); }
      else if (req.url === "/settle") { settles++; res.end(JSON.stringify({ success: true, payer, transaction: `0x${"aa".repeat(32)}`, network: "eip155:84532", amount: "50000" })); }
      else { res.statusCode = 404; res.end("{}"); }
    });
    await new Promise<void>((resolve) => facilitator.listen(0, "127.0.0.1", resolve));
    facilitatorUrl = `http://127.0.0.1:${(facilitator.address() as AddressInfo).port}`;
  });
  afterAll(async () => new Promise<void>((resolve, reject) => facilitator.close((error) => error ? reject(error) : resolve())));

  function application(bazaarEnabled = true) {
    return createSellerBApplication({
      paymentMode: "x402", bazaarEnabled, publicUrl: "https://seller-b.example.com",
      facilitatorUrl, payToAddress: "0x3333333333333333333333333333333333333333",
      purchaseContextHmacSecret: "test-only-public-seller-context-secret-32",
    }, { idempotencyStore: new InMemoryIdempotencyStore() });
  }

  it("returns a valid public 402 declaration without requiring Mello credentials or known input", async () => {
    const { app } = application();
    const res = await request(app).post("/v1/credit-report").send({}).expect(402);
    const required = decodePaymentRequiredHeader(res.headers[PAYMENT_REQUIRED_HEADER]!);
    expect(required.extensions?.["bazaar"]).toMatchObject({ info: { input: { type: "http", method: "POST", body: { serviceId: "macro-analysis", serviceCategory: "macro_analysis", serviceQuery: "總經分析" } } } });
    expect(validateDiscoveryExtension(required.extensions?.["bazaar"] as Parameters<typeof validateDiscoveryExtension>[0]).valid).toBe(true);
    expect(required.extensions).toHaveProperty("tw-einvoice");
    expect(JSON.stringify(required.extensions)).not.toContain("test-only-public-seller-context-secret");
  });
  it("keeps actual buyer input out of the published discovery example", async () => {
    const { app } = application();
    const res = await request(app).post("/v1/credit-report").send({ targetCompanyName: "Private Procurement Target" }).expect(402);
    const required = decodePaymentRequiredHeader(res.headers[PAYMENT_REQUIRED_HEADER]!);
    expect(JSON.stringify(required.extensions?.["bazaar"])).not.toContain("Private Procurement Target");
  });
  it("retains the private mode boundary", async () => {
    const { app } = application(false);
    await request(app).post("/v1/credit-report").send({ targetCompanyName: "Example Co." }).expect(400);
  });
  it("does not accept forged Mello context or charge for malformed paid input", async () => {
    const { app } = application();
    const before = { verifies, settles };
    await request(app).post("/v1/credit-report").send({ targetCompanyName: "Example Co.", purchaseContextToken: "forged-token-not-issued-by-mello" }).expect(401);
    await request(app).post("/v1/credit-report").set("payment-signature", "invalid").send({}).expect(400);
    await request(app).post("/v1/credit-report").set("payment-signature", "invalid")
      .send({ serviceId: "macro-analysis", serviceCategory: "crypto_market", serviceQuery: "總經分析" }).expect(400);
    await request(app).post("/v1/credit-report").set("payment-signature", "invalid")
      .send({ serviceId: "stock-analysis", serviceCategory: "stock_analysis", serviceQuery: "個股分析" }).expect(400);
    expect({ verifies, settles }).toEqual(before);
  });
  it.each([
    { targetCompanyName: "Example Co." },
    { serviceId: "macro-analysis", serviceCategory: "macro_analysis", serviceQuery: "總經分析" },
    { serviceId: "crypto-market", serviceCategory: "crypto_market", serviceQuery: "加密市場資訊" },
  ])("serves a public x402 buyer without a Mello token and replays without another settlement: %j", async (body) => {
    const { app, config } = application();
    const before = settles;
    const signature = encodePaymentSignatureHeader({
      x402Version: 2, resource: { url: `${config.publicUrl}/v1/credit-report`, mimeType: "application/json" },
      accepted: createPaymentRequirements(config),
      payload: { signature: `0x${"cd".repeat(65)}`, authorization: {
        from: payer, to: config.payToAddress, value: config.priceAtomic,
        validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 300), nonce: `0x${"ef".repeat(32)}`,
      } },
      extensions: { "payment-identifier": { info: { required: true, id: "pay_bazaar_public_protocol_0001" } } },
    });
    const call = () => request(app).post("/v1/credit-report").set("payment-signature", signature)
      .set("x-mello-internal-purchase-id", "untrusted-header").send(body);
    const first = await call().expect(200);
    const second = await call().expect(200);
    expect(first.body).toMatchObject({ isDemo: true, provider: "seller-b" });
    if (body.serviceId) expect(first.body).toMatchObject({ ...body, reportVersion: "market-v1" });
    expect(second.body).toEqual(first.body);
    expect(settles - before).toBe(1);
  });
  it("refuses to advertise mock or private endpoints as Bazaar services", () => {
    expect(() => createSellerBApplication({ bazaarEnabled: true })).toThrow("Bazaar publishing requires");
  });
});
