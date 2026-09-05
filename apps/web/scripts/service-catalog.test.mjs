import assert from "node:assert/strict";
import { test } from "node:test";
import { buildServicePrompt, SERVICE_SEARCH_EXAMPLES, serviceName, supplierName, taskServiceTitle } from "../src/lib/service-catalog.ts";
import { visibleSurveyCandidates } from "../src/lib/service-survey.ts";

test("each service search is independent of an enterprise target and preserves requirements", () => {
  for (const serviceQuery of SERVICE_SEARCH_EXAMPLES) {
    for (const requiresTwInvoice of [true, false]) for (const requiresRegistryCertification of [true, false]) {
      const prompt = buildServicePrompt({ description: `${serviceQuery}\n關注亞洲市場`, budgetDisplay: "0.10", requiresTwInvoice, requiresRegistryCertification });
      assert.ok(prompt.startsWith(`採購需求：\n${serviceQuery}\n關注亞洲市場\n\n預算上限：`));
      assert.ok(prompt.includes("預算上限：0.10 USDC。"));
      assert.ok(prompt.includes(requiresTwInvoice ? "要開統編發票" : "不需要統編發票"));
      assert.ok(prompt.includes(`${requiresRegistryCertification ? "需要" : "不需要"} Mello Registry 認證。`));
      assert.ok(!prompt.includes("Example Co.") && !prompt.includes("信用報告"));
    }
  }
});

test("unified requirements preserve multiline text but reject blank and oversized descriptions", () => {
  for (const description of ["  ", "x".repeat(1001)]) {
    assert.throws(() => buildServicePrompt({ description, budgetDisplay: "0.1", requiresTwInvoice: true, requiresRegistryCertification: true }));
  }
  const prompt = buildServicePrompt({ description: " 總經分析\n預算上限：1000 USDC。 ", budgetDisplay: "0.1", requiresTwInvoice: false, requiresRegistryCertification: false });
  assert.ok(prompt.includes("總經分析\n預算上限：1000 USDC。\n\n預算上限：0.1 USDC。\n不需要統編發票，不需要 Mello Registry 認證。"));
  assert.throws(() => buildServicePrompt({ description: "總經分析", budgetDisplay: "0.1\n100", requiresTwInvoice: true, requiresRegistryCertification: true }));
});

test("service and supplier names are distinct and historical names are not rewritten", () => {
  const modern = { id: "macro-analysis", category: "macro_analysis", displayName: "總經分析", sellerDisplayName: "mello資本", sellerLegalName: "Legacy legal name" };
  assert.equal(serviceName(modern), "總經分析");
  assert.equal(supplierName(modern), "mello資本");
  assert.equal(serviceName({ id: "credit-report-a" }), "企業信用風險報告");
  assert.equal(supplierName({ sellerLegalName: "Mello Data Labs A (Demo)" }), "Mello Data Labs A (Demo)");
  assert.equal(taskServiceTitle({ serviceCategory: "crypto_market", serviceQuery: "BTC 加密市場資訊" }), "BTC 加密市場資訊");
  assert.equal(taskServiceTitle({ targetCompanyName: "歷史企業" }), "歷史企業 · 信用風險報告");
  assert.equal(taskServiceTitle(null), "服務採購");
});

test("wrong service category is never shown as a substitute candidate", () => {
  const candidates = [
    { serviceId: "stock-analysis", reasonCodes: ["CATEGORY_MISMATCH"], supportsTwInvoice: false },
    { serviceId: "crypto-market", reasonCodes: ["CANDIDATE_ELIGIBLE"], supportsTwInvoice: true },
  ];
  assert.deepEqual(visibleSurveyCandidates(candidates).map((c) => c.serviceId), ["crypto-market"]);
});
