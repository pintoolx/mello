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
  description: string; budgetDisplay: string; requiresTwInvoice: boolean;
  requiresRegistryCertification: boolean;
}): string {
  const description = input.description.trim();
  if (!description || description.length > 1000) {
    throw new Error("請輸入 1 至 1000 字的需求說明，例如：總經分析，關注亞洲市場。");
  }
  if (!/^\d+(?:\.\d{1,6})?$/u.test(input.budgetDisplay)) throw new Error("預算格式不正確。");
  return `採購需求：\n${description}\n\n預算上限：${input.budgetDisplay} USDC。\n${input.requiresTwInvoice ? "要開統編發票" : "不需要統編發票"}，${input.requiresRegistryCertification ? "需要" : "不需要"} Mello Registry 認證。`;
}
