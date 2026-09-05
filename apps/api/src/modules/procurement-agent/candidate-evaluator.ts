import type {
  CandidateEvaluation,
  PolicyInput,
  PurchaseIntent,
  ServiceRecord,
} from "@mello/shared";

export interface CandidateEvaluationInput {
  intent: PurchaseIntent;
  policy: PolicyInput;
  services: readonly ServiceRecord[];
}

export function evaluateCandidates({
  intent,
  policy,
  services,
}: CandidateEvaluationInput): CandidateEvaluation[] {
  return services
    .map((service): CandidateEvaluation => {
      const reasons: string[] = [];
      if (!service.active) reasons.push("SERVICE_INACTIVE");
      if (service.category !== intent.serviceCategory) reasons.push("CATEGORY_MISMATCH");
      if (BigInt(service.priceAtomic) > BigInt(intent.maxAmount.atomic)) {
        reasons.push("AMOUNT_OVER_USER_BUDGET");
      }
      if (!policy.allowedNetworks.includes(service.network)) reasons.push("NETWORK_NOT_ALLOWED");
      const allowedToken = policy.allowedTokens.some(
        (token) =>
          token.symbol === service.tokenSymbol &&
          token.address.toLowerCase() === service.tokenAddress.toLowerCase() &&
          token.decimals === service.tokenDecimals,
      );
      if (!allowedToken) reasons.push("TOKEN_NOT_ALLOWED");
      if (!policy.allowedSellerIds.includes(service.sellerId)) reasons.push("SELLER_NOT_ALLOWED");
      if ((intent.requiresTwInvoice || policy.requireTwInvoice) && !service.supportsTwInvoice) {
        reasons.push("INVOICE_UNSUPPORTED");
      }
      const eligible = reasons.length === 0;
      return {
        serviceId: service.id,
        sellerId: service.sellerId,
        sellerLegalName: service.sellerLegalName,
        invoiceCapability: service.invoiceCapability,
        supportsTwInvoice: service.supportsTwInvoice,
        priceAtomic: service.priceAtomic,
        eligible,
        reasonCodes: eligible ? ["CANDIDATE_ELIGIBLE"] : reasons,
        humanSummary: eligible
          ? `${service.sellerLegalName} 符合預算、付款與發票政策。`
          : `${service.sellerLegalName} 未通過：${reasons.join("、")}。`,
      };
    })
    .sort((left, right) => {
      if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
      const priceComparison = BigInt(left.priceAtomic) - BigInt(right.priceAtomic);
      if (priceComparison !== 0n) return priceComparison < 0n ? -1 : 1;
      const leftService = services.find((service) => service.id === left.serviceId);
      const rightService = services.find((service) => service.id === right.serviceId);
      if (leftService?.supportsTwInvoice !== rightService?.supportsTwInvoice) {
        return leftService?.supportsTwInvoice ? -1 : 1;
      }
      return left.sellerId.localeCompare(right.sellerId);
    });
}

export function selectCandidate(
  candidates: readonly CandidateEvaluation[],
): CandidateEvaluation | undefined {
  return candidates.find((candidate) => candidate.eligible);
}
