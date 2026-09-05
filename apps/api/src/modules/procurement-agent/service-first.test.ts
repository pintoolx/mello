import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ALLOWED_TOKEN, DEMO_COMPANY, MARKET_SERVICE_CATALOG, MELLO_NETWORK, PurchaseIntentSchema, type PolicyInput } from "@mello/shared";
import { parsePurchaseIntentFallback } from "./fallback-parser.js";
import { ProcurementAgent } from "./agent.js";
import { evaluateCandidates, selectCandidate } from "./candidate-evaluator.js";
import { surveyCandidate } from "./survey.js";
import { evaluatePolicy } from "../policies/policy-engine.js";
import { registryFixture } from "../service-registry/fixtures.js";

const input = (prompt: string) => ({ prompt, company: DEMO_COMPANY, policyPerTxLimitAtomic: "100000" });
const policy: PolicyInput = { perTxLimitAtomic: "100000", dailyLimitAtomic: "1000000", requireTwInvoice: false,
  allowedNetworks: [MELLO_NETWORK], allowedTokens: [DEFAULT_ALLOWED_TOKEN], allowedSellerIds: ["seller-a", "seller-b"] };
const structured = (query: string) => `搜尋服務：${query}\n預算上限：0.1 USDC。\n不需要統編發票，不需要 Mello Registry 認證。`;

describe("service-first intent contract", () => {
  it.each(MARKET_SERVICE_CATALOG)("parses $displayName without a fabricated company", (product) => {
    const intent = parsePurchaseIntentFallback(input(structured(product.displayName)));
    expect(intent).toMatchObject({ serviceCategory: product.category, serviceQuery: product.displayName,
      usedDemoDefaultTarget: false, maxAmount: { atomic: "100000" }, requiresTwInvoice: false });
    expect(intent).not.toHaveProperty("targetCompanyName");
    expect(PurchaseIntentSchema.safeParse(intent).success).toBe(true);
  });

  it.each([
    ["stock analysis", "stock_analysis"], ["macroeconomic analysis", "macro_analysis"],
    ["crypto market information", "crypto_market"], ["futures analysis", "futures_analysis"],
  ])("recognizes %s in a free text request", (query, category) => {
    const intent = parsePurchaseIntentFallback(input(`Find ${query}, budget 0.05 USDC`));
    expect(intent.serviceCategory).toBe(category);
    expect(intent.serviceQuery).not.toMatch(/USDC|budget/i);
    expect(intent).not.toHaveProperty("targetCompanyName");
  });

  it("only forwards the service line, not buyer details, budget or conflicting private notes", () => {
    const intent = parsePurchaseIntentFallback(input(`${structured("加密市場資訊，關注 BTC 流動性")}\n補充需求：股票研究另案；內部企業 Secret Corp；統編 12345675；舊上限 3 USDC`));
    expect(intent.serviceCategory).toBe("crypto_market");
    expect(intent.serviceQuery).toBe("加密市場資訊，關注 BTC 流動性");
    expect(intent.maxAmount.atomic).toBe("100000");
    expect(intent.serviceQuery).not.toMatch(/Secret|12345675|USDC|股票/);
  });

  it.each(["搜尋服務：股票分析與加密市場資訊", "搜尋服務：雲端儲存", "搜尋服務：期貨分析\n搜尋服務：總經分析",
    "搜尋服務：\n補充需求：加密市場資訊", "搜尋服務：   \n補充需求：個股分析"])(
    "rejects unknown or ambiguous service instead of falling back to credit: %s", (prompt) => {
      expect(() => parsePurchaseIntentFallback(input(prompt))).toThrow(/服務/);
    },
  );

  it("requires a nonempty bounded query and forbids legacy target/default fields for modern intents", () => {
    const intent = parsePurchaseIntentFallback(input(structured("總經分析")));
    for (const changed of [
      { ...intent, serviceQuery: undefined }, { ...intent, serviceQuery: " " }, { ...intent, serviceQuery: "a".repeat(201) },
      { ...intent, targetCompanyName: "Example Co." }, { ...intent, usedDemoDefaultTarget: true },
    ]) expect(PurchaseIntentSchema.safeParse(changed).success).toBe(false);
    expect(PurchaseIntentSchema.safeParse(parsePurchaseIntentFallback(input("買 Example Co. 的信用報告"))).success).toBe(true);
  });

  it("keeps the strictest budget and an explicit invoice requirement for service-first requests", () => {
    const intent = parsePurchaseIntentFallback(input("搜尋服務：總經分析\n上限 0.03 USDC，原上限 100 USDC，要統編發票"));
    expect(intent.maxAmount.atomic).toBe("30000");
    expect(intent.requiresTwInvoice).toBe(true);
  });

  it("preserves the mandatory target contract for legacy credit reports", () => {
    const legacy = parsePurchaseIntentFallback(input("買 Example Co. 的信用報告"));
    expect(PurchaseIntentSchema.safeParse(legacy).success).toBe(true);
    for (const targetCompanyName of [undefined, "", "   "]) {
      expect(PurchaseIntentSchema.safeParse({ ...legacy, targetCompanyName }).success).toBe(false);
    }
    expect(PurchaseIntentSchema.safeParse({ ...legacy, serviceQuery: "總經分析" }).success).toBe(false);
  });

  it("does not accept a model category change to a cheaper service", async () => {
    const parse = vi.fn(async () => ({ output_parsed: { serviceCategory: "stock_analysis", targetCompanyName: "Invented Corp",
      maxAmountDisplay: "999", requiresTwInvoice: false } }));
    const client = { responses: { parse } } as unknown as OpenAI;
    const result = await new ProcurementAgent({ mode: "openai", model: "test", client }).parse(input(structured("加密市場資訊")));
    expect(result.usedFallback).toBe(true);
    expect(result.intent.serviceCategory).toBe("crypto_market");
    expect(result.intent.maxAmount.atomic).toBe("100000");
    expect(result.intent).not.toHaveProperty("targetCompanyName");
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("drops a hallucinated company even when the model recognizes the right modern service", async () => {
    const client = { responses: { parse: vi.fn(async () => ({ output_parsed: {
      serviceCategory: "macro_analysis", targetCompanyName: "Invented Corp", maxAmountDisplay: null, requiresTwInvoice: false,
    } })) } } as unknown as OpenAI;
    const result = await new ProcurementAgent({ mode: "openai", model: "test", client }).parse(input(structured("總經分析")));
    expect(result.usedFallback).toBe(false);
    expect(result.intent).not.toHaveProperty("targetCompanyName");
    expect(result.intent.serviceQuery).toBe("總經分析");
  });
});

describe("category boundaries before selection and payment", () => {
  const stock = { ...registryFixture, id: "stock-analysis", category: "stock_analysis" as const, priceAtomic: "10000" };
  const crypto = { ...registryFixture, id: "crypto-market", category: "crypto_market" as const, priceAtomic: "50000" };
  const intent = parsePurchaseIntentFallback(input(structured("加密市場資訊")));

  it("never buys the cheaper stock service for a crypto request", () => {
    const candidates = evaluateCandidates({ intent, policy, services: [stock, crypto] });
    expect(selectCandidate(candidates)?.serviceId).toBe("crypto-market");
    const mismatch = candidates.find((candidate) => candidate.serviceId === stock.id)!;
    expect(mismatch).toMatchObject({ eligible: false, reasonCodes: ["CATEGORY_MISMATCH"] });
    const survey = surveyCandidate(mismatch, stock, { requiresTwInvoice: false, requiresRegistryCertification: false }, { status: "VERIFIED", revision: 1 });
    expect(survey).toMatchObject({ matchesRequirements: false, eligible: false });
    expect(selectCandidate(evaluateCandidates({ intent, policy, services: [stock] }))).toBeUndefined();
  });

  it("policy independently rejects a mismatched category despite favorable financial terms", () => {
    const result = evaluatePolicy({ intent, service: stock, policy: { ...policy, version: 1 }, company: DEMO_COMPANY, dailySettledAtomic: "0" });
    expect(result.approved).toBe(false);
    expect(result.reasonCodes).toContain("CATEGORY_MISMATCH");
  });

  it("invoice and certification filtering never converts a wrong category to a match", () => {
    const candidate = evaluateCandidates({ intent, policy, services: [stock] })[0]!;
    for (const requiresTwInvoice of [true, false]) for (const requiresRegistryCertification of [true, false]) {
      expect(surveyCandidate(candidate, stock, { requiresTwInvoice, requiresRegistryCertification },
        { status: "VERIFIED", revision: 1 }).matchesRequirements).toBe(false);
    }
  });

  it("uses the reviewed catalog display supplier in summaries without rewriting its legal identity", () => {
    const branded = { ...crypto, sellerLegalName: "Mello Data Labs B (Demo)", sellerDisplayName: "mello資本" };
    const candidate = evaluateCandidates({ intent, policy, services: [branded] })[0]!;
    expect(candidate.humanSummary).toContain("mello資本");
    expect(candidate.humanSummary).not.toContain("Mello Data Labs");
    expect(candidate.sellerLegalName).toBe("Mello Data Labs B (Demo)");
    expect(surveyCandidate(candidate, branded, { requiresTwInvoice: false, requiresRegistryCertification: false },
      { status: "UNREVIEWED", revision: null }).humanSummary).toContain("mello資本");
  });
});
