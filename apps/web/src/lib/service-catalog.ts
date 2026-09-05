import type { Intent, Service } from "./core-api";

export const SERVICE_SEARCH_EXAMPLES = ["個股分析", "總經分析", "加密市場資訊", "期貨分析"] as const;

const CATEGORY_NAMES: Record<string, string> = {
  stock_analysis: "個股分析", macro_analysis: "總經分析",
  crypto_market: "加密市場資訊", futures_analysis: "期貨分析",
  credit_report: "企業信用風險報告",
};

export function serviceName(service: Pick<Service, "displayName" | "category" | "id" | "serviceId">): string {
  return service.displayName || CATEGORY_NAMES[service.category ?? ""] ||
    ((service.id ?? service.serviceId)?.startsWith("credit-report-") ? "企業信用風險報告" : "未命名服務");
}

export function supplierName(service: Pick<Service, "sellerDisplayName" | "sellerLegalName">): string {
  return service.sellerDisplayName || service.sellerLegalName;
}

export function intentServiceName(intent: Intent | null | undefined): string {
  return intent?.serviceCategory ? CATEGORY_NAMES[intent.serviceCategory] ?? "服務採購" :
    intent?.targetCompanyName ? "企業信用風險報告" : "服務採購";
}

export function taskServiceTitle(intent: Intent | null | undefined): string {
  if (intent?.serviceQuery) return intent.serviceQuery;
  if (intent?.targetCompanyName) return `${intent.targetCompanyName} · 信用風險報告`;
  return intentServiceName(intent);
}

export function buildServicePrompt(input: {
  serviceQuery: string; budgetDisplay: string; requiresTwInvoice: boolean;
  requiresRegistryCertification: boolean; notes: string;
}): string {
  const query = input.serviceQuery.trim();
  if (!query || query.length > 200 || /[\r\n]/u.test(query)) {
    throw new Error("請輸入 1 至 200 字的服務需求，例如：總經分析。");
  }
  return `搜尋服務：${query}\n預算上限：${input.budgetDisplay} USDC。\n${input.requiresTwInvoice ? "要開統編發票" : "不需要統編發票"}，${input.requiresRegistryCertification ? "需要" : "不需要"} Mello Registry 認證。${input.notes.trim() ? `\n補充需求：${input.notes.trim()}` : ""}`;
}
