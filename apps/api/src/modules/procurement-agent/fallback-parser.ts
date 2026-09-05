import type { CompanyProfileInput, PurchaseIntent } from "@mello/shared";
import { MELLO_NETWORK, formatUsdcAtomic, getMarketServiceForCategory, parseUsdcToAtomic, type ServiceCategory } from "@mello/shared";

const EXPLICIT_USDC_AMOUNT_PATTERN = /(\d+(?:\.\d{1,6})?)\s*USDC\b/giu;
const TARGET_PATTERNS = [
  /出貨給\s*([^。！!，,\n]+)[。！!，,]/u,
  /(?:買|購買)(?:一份|一個)?\s*(.+?)\s*的(?:信用報告|徵信報告|企業徵信)/u,
  /(?:查詢|調查)\s*(.+?)\s*的(?:信用|徵信)/u,
  /(?:buy|purchase)(?:\s+a)?\s+(.+?)\s+(?:credit\s+report|credit\s+check)/iu,
] as const;

const CATEGORY_PATTERNS: readonly [ServiceCategory, RegExp][] = [
  ["stock_analysis", /個股|股票|股價|\b(?:stocks?|equity)\b/iu],
  ["macro_analysis", /總經|總體經濟|宏觀|\bmacro(?:economic|economics)?\b/iu],
  ["crypto_market", /加密|虛擬貨幣|數位資產|\bcrypto(?:currency|currencies)?\b/iu],
  ["futures_analysis", /期貨|\bfutures?\b/iu],
  ["credit_report", /信用報告|徵信|信用|credit\s+(?:report|check)/iu],
];

export function requestedService(prompt: string): { category: ServiceCategory; query?: string } {
  const structured = [...prompt.matchAll(/^搜尋服務[：:][ \t]*([^\r\n]*)$/gmu)];
  if (structured.length > 1) throw new Error("一次只能搜尋一項服務，請保留一行服務需求。");
  const primary = structured[0]?.[1]?.trim();
  if (structured.length && !primary) throw new Error("請填寫要搜尋的服務，不能以補充需求代替。");
  if (primary && primary.length > 200) throw new Error("服務需求請限制在 200 字內。");
  const categories = CATEGORY_PATTERNS.filter(([, pattern]) => pattern.test(primary ?? prompt));
  if (categories.length !== 1) {
    throw new Error(categories.length
      ? "一次請選擇一種服務：個股分析、總經分析、加密市場資訊或期貨分析；其他需求可另建申請。"
      : "請指定要搜尋的服務：個股分析、總經分析、加密市場資訊或期貨分析。");
  }
  const category = categories[0]![0];
  // Structured UI requests preserve the user's service text only, never budget,
  // invoice fields or private supplemental notes. Legacy free text is reduced to
  // its recognized service label rather than forwarded wholesale to the seller.
  return category === "credit_report" ? { category } : {
    category,
    query: primary ?? getMarketServiceForCategory(category)!.displayName,
  };
}

export interface FallbackParserInput {
  prompt: string;
  company: CompanyProfileInput;
  policyPerTxLimitAtomic: string;
}

/**
 * A prompt can contain quoted prices, old limits, or conflicting instructions.
 * Treat every explicit USDC amount as a ceiling and select the smallest one;
 * an unambiguous manual-approval clause is enforced separately by ProcurementControls.
 * a parser or model must never silently expand the user's stated authority.
 */
export function extractConservativeUsdcBudget(
  prompt: string,
): { atomic: string; display: string } | null {
  const budgetText = prompt.replace(/超過\s*\d+(?:\.\d{1,6})?\s*USDC\s*(?:先問我|需(?:要)?核准|先核准)/giu, "");
  const matches = [...budgetText.matchAll(EXPLICIT_USDC_AMOUNT_PATTERN)];
  if (matches.length === 0) return null;

  return matches.reduce<{ atomic: string; display: string } | null>(
    (smallest, match) => {
      const display = match[1];
      if (!display) return smallest;
      const candidate = { atomic: parseUsdcToAtomic(display), display };
      if (!smallest || BigInt(candidate.atomic) < BigInt(smallest.atomic)) {
        return candidate;
      }
      return smallest;
    },
    null,
  );
}

function extractTargetCompany(prompt: string): {
  targetCompanyName: string;
  usedDemoDefaultTarget: boolean;
} {
  for (const pattern of TARGET_PATTERNS) {
    const match = pattern.exec(prompt);
    const candidate = match?.[1]?.trim().replace(/[，,。!！?？]+$/u, "");
    if (candidate) {
      return { targetCompanyName: candidate, usedDemoDefaultTarget: false };
    }
  }
  return { targetCompanyName: "Example Co.", usedDemoDefaultTarget: true };
}

function extractInvoiceRequirement(prompt: string): boolean {
  if (/(?:不需要|不用|免開|無需|不要)(?:統編)?發票/u.test(prompt)) return false;
  return /統編|發票/u.test(prompt);
}

export function parsePurchaseIntentFallback({
  prompt,
  company,
  policyPerTxLimitAtomic,
}: FallbackParserInput): PurchaseIntent {
  const service = requestedService(prompt);

  const explicitBudget = extractConservativeUsdcBudget(prompt);
  const maxAmount = explicitBudget
    ? { ...explicitBudget, token: "USDC" as const }
    : {
        atomic: policyPerTxLimitAtomic,
        display: formatUsdcAtomic(policyPerTxLimitAtomic),
        token: "USDC" as const,
      };
  const target = service.category === "credit_report" ? extractTargetCompany(prompt) : null;

  return {
    serviceCategory: service.category,
    ...(target ? { targetCompanyName: target.targetCompanyName } : { serviceQuery: service.query! }),
    maxAmount,
    requiresTwInvoice: extractInvoiceRequirement(prompt),
    buyerBusinessId: company.businessId,
    costCenter: company.defaultCostCenter,
    networkPreference: MELLO_NETWORK,
    usedDemoDefaultTarget: target?.usedDemoDefaultTarget ?? false,
  };
}
