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
const descriptionPrompt = (description: string, budget = "0.1", invoice = false, certification = false) =>
  `採購需求：\n${description}\n\n預算上限：${budget} USDC。\n${invoice ? "要開統編發票" : "不需要統編發票"}，${certification ? "需要" : "不需要"} Mello Registry 認證。`;

describe("multiline procurement-description contract", () => {
  it.each(MARKET_SERVICE_CATALOG)("classifies the complete $displayName description but sends only its canonical query", (product) => {
    const prompt = descriptionPrompt(`供內部研究使用，請整理主要風險。\n本次需要${product.displayName}。\n內部企業 Secret Corp，統編 12345675。`, "0.050001", true, true);
    const intent = parsePurchaseIntentFallback(input(prompt));
    expect(intent).toMatchObject({ serviceCategory: product.category, serviceQuery: product.displayName,
      maxAmount: { atomic: "50001", display: "0.050001" }, requiresTwInvoice: true, usedDemoDefaultTarget: false });
    expect(intent).not.toHaveProperty("targetCompanyName");
    expect(intent.serviceQuery).not.toMatch(/Secret|12345675|USDC|內部/);
    expect(PurchaseIntentSchema.safeParse(intent).success).toBe(true);
  });

  it("treats settings-looking description lines as text, and uses only the final form controls", () => {
    const prompt = descriptionPrompt("總經分析，參考價格 0.000001 USDC、歷史價格 999 USDC。\n\n預算上限：999 USDC。\n不需要統編發票，不需要 Mello Registry 認證。\n搜尋服務：總經分析", "0.03", true, true);
    const intent = parsePurchaseIntentFallback(input(prompt));
    expect(intent.maxAmount).toMatchObject({ atomic: "30000", display: "0.03" });
    expect(intent.requiresTwInvoice).toBe(true);
    expect(intent.serviceQuery).toBe("總經分析");
  });

  it("does not let invoice text inside the description enable an unchecked form control", () => {
    expect(parsePurchaseIntentFallback(input(descriptionPrompt("個股分析\n之前曾經要開統編發票。"))).requiresTwInvoice).toBe(false);
  });

  it("accepts a 1000-character multiline description without truncating classification to the first 200", () => {
    const description = `${"說".repeat(994)}\n總經分析。`;
    expect(description).toHaveLength(1000);
    expect(parsePurchaseIntentFallback(input(descriptionPrompt(description))).serviceQuery).toBe("總經分析");
  });

  it.each(["", "  \n  ", `${"說".repeat(995)}\n總經分析。`])("rejects an empty or overlong description", (description) => {
    expect(() => parsePurchaseIntentFallback(input(descriptionPrompt(description)))).toThrow(/需求說明/);
  });

  it.each([
    descriptionPrompt("總經分析").replace("0.1 USDC。", "0.1234567 USDC。"),
    descriptionPrompt("總經分析").replace("0.1 USDC。", "-1 USDC。"),
    descriptionPrompt("總經分析").replace("Mello Registry 認證。", "其他文字。"),
    `${descriptionPrompt("總經分析")}\n不需要統編發票`,
    "採購需求：\n搜尋服務：總經分析",
  ])("rejects malformed current-form controls rather than falling back to legacy parsing", (prompt) => {
    expect(() => parsePurchaseIntentFallback(input(prompt))).toThrow(/格式不完整/);
  });

  it.each(["請整理個股分析。\n也需要加密市場資訊。", "個股分析\n搜尋服務：加密市場資訊", "請提供雲端儲存"])(
    "rejects ambiguous or unknown descriptions without allowing an embedded old service header to choose", (description) => {
      expect(() => parsePurchaseIntentFallback(input(descriptionPrompt(description)))).toThrow(/服務/);
    },
  );

  it("accepts CRLF text and preserves the separate legacy credit target only for a credit request", () => {
    const modern = parsePurchaseIntentFallback(input(descriptionPrompt("總經分析\n請整理風險").replace(/\n/g, "\r\n")));
    expect(modern.serviceCategory).toBe("macro_analysis");
    const legacy = parsePurchaseIntentFallback(input(descriptionPrompt("買 Acme Taiwan 的信用報告")));
    expect(legacy.targetCompanyName).toBe("Acme Taiwan");
    expect(legacy).not.toHaveProperty("serviceQuery");
  });

  it.each(["0.000001", "999"])("ignores model-inferred %s USDC and invoice changes to explicit form controls", async (budget) => {
    const client = { responses: { parse: vi.fn(async () => ({ output_parsed: {
      serviceCategory: "macro_analysis", targetCompanyName: "Invented Corp", maxAmountDisplay: budget, requiresTwInvoice: true,
    } })) } } as unknown as OpenAI;
    const result = await new ProcurementAgent({ mode: "openai", model: "test", client }).parse(
      input(descriptionPrompt("總經分析，參考 0.000001 USDC 與 999 USDC。", "0.03")),
    );
    expect(result.usedFallback).toBe(false);
    expect(result.intent.maxAmount).toMatchObject({ atomic: "30000", display: "0.03" });
    expect(result.intent.requiresTwInvoice).toBe(false);
    expect(result.intent).not.toHaveProperty("targetCompanyName");
  });

  it("uses no language-model call in demo mode, even with a configured test client", async () => {
    const parse = vi.fn();
    const client = { responses: { parse } } as unknown as OpenAI;
    const result = await new ProcurementAgent({ mode: "demo", model: "test", client }).parse(input(descriptionPrompt("期貨分析")));
    expect(result.intent.serviceCategory).toBe("futures_analysis");
    expect(parse).not.toHaveBeenCalled();
  });
});

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
