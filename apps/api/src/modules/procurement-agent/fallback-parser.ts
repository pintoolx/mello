import type { CompanyProfileInput, PurchaseIntent } from "@mello/shared";
import { MELLO_NETWORK, formatUsdcAtomic, parseUsdcToAtomic } from "@mello/shared";

const EXPLICIT_USDC_AMOUNT_PATTERN = /(\d+(?:\.\d{1,6})?)\s*USDC\b/giu;
const TARGET_PATTERNS = [
  /出貨給\s*([^。！!，,\n]+)[。！!，,]/u,
  /(?:買|購買)(?:一份|一個)?\s*(.+?)\s*的(?:信用報告|徵信報告|企業徵信)/u,
  /(?:查詢|調查)\s*(.+?)\s*的(?:信用|徵信)/u,
  /(?:buy|purchase)(?:\s+a)?\s+(.+?)\s+(?:credit\s+report|credit\s+check)/iu,
] as const;

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
  if (!/信用報告|徵信|信用|credit\s+(?:report|check)/iu.test(prompt)) {
    throw new Error("Demo parser only supports credit report procurement");
  }

  const explicitBudget = extractConservativeUsdcBudget(prompt);
  const maxAmount = explicitBudget
    ? { ...explicitBudget, token: "USDC" as const }
    : {
        atomic: policyPerTxLimitAtomic,
        display: formatUsdcAtomic(policyPerTxLimitAtomic),
        token: "USDC" as const,
      };
  const target = extractTargetCompany(prompt);

  return {
    serviceCategory: "credit_report",
    targetCompanyName: target.targetCompanyName,
    maxAmount,
    requiresTwInvoice: extractInvoiceRequirement(prompt),
    buyerBusinessId: company.businessId,
    costCenter: company.defaultCostCenter,
    networkPreference: MELLO_NETWORK,
    usedDemoDefaultTarget: target.usedDemoDefaultTarget,
  };
}
