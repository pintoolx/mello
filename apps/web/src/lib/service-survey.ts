import type { Service } from "./core-api";

export function visibleSurveyCandidates(candidates: Service[], requirements?: {
  requiresTwInvoice: boolean;
  requiresRegistryCertification: boolean;
} | null) {
  return candidates.filter((candidate) => candidate.matchesRequirements !== false &&
    (!requirements?.requiresTwInvoice || candidate.supportsTwInvoice) &&
    (!requirements?.requiresRegistryCertification || candidate.verificationStatus === "VERIFIED"));
}

export function surveyReason(reason: string) {
  const labels: Record<string, string> = {
    AMOUNT_OVER_USER_BUDGET: "報價超過申請預算",
    AMOUNT_OVER_PER_TX_LIMIT: "報價超過公司單筆上限",
    INVOICE_UNSUPPORTED: "公司政策或申請仍要求發票",
    SELLER_NOT_ALLOWED: "未列入公司的可採購供應商",
    NETWORK_NOT_ALLOWED: "付款網路不符公司政策",
    TOKEN_NOT_ALLOWED: "付款幣別不符公司政策",
    SERVICE_INACTIVE: "服務已停用",
    BAZAAR_SERVICE_NOT_FOUND_OR_CHANGED: "公開目錄未提供相符報價",
  };
  return labels[reason] ?? (reason.startsWith("VERIFICATION_") ? "Mello Registry 認證尚未通過或已失效" : reason);
}
