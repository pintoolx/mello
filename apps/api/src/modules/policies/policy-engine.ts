import type {
  CompanyProfileInput,
  PolicyDecision,
  PolicyInput,
  PurchaseIntent,
  ServiceRecord,
} from "@mello/shared";
import { isValidTaiwanBusinessId } from "@mello/shared";
import type { ValidatedPaymentTerms } from "../x402-buyer/payment-provider.js";

export interface PolicyEngineInput {
  intent: PurchaseIntent;
  service: ServiceRecord;
  policy: PolicyInput & { version: number };
  company: CompanyProfileInput;
  dailySettledAtomic: string;
  livePaymentTerms?: ValidatedPaymentTerms;
  expectedFacilitatorUrl?: string;
  now?: Date;
}

export function evaluatePolicy({
  intent,
  service,
  policy,
  company,
  dailySettledAtomic,
  livePaymentTerms,
  expectedFacilitatorUrl,
  now = new Date(),
}: PolicyEngineInput): PolicyDecision {
  const rejectReasons: string[] = [];
  const price = BigInt(service.priceAtomic);
  const dailyBefore = BigInt(dailySettledAtomic);
  const dailyAfter = dailyBefore + price;
  const invoiceRequired = policy.requireTwInvoice || intent.requiresTwInvoice;

  if (service.category !== intent.serviceCategory) rejectReasons.push("CATEGORY_MISMATCH");
  if (price > BigInt(policy.perTxLimitAtomic)) rejectReasons.push("PER_TX_LIMIT_EXCEEDED");
  if (price > BigInt(intent.maxAmount.atomic)) rejectReasons.push("USER_BUDGET_EXCEEDED");
  if (dailyAfter > BigInt(policy.dailyLimitAtomic)) rejectReasons.push("DAILY_LIMIT_EXCEEDED");
  if (!policy.allowedSellerIds.includes(service.sellerId)) rejectReasons.push("SELLER_NOT_ALLOWED");
  if (!policy.allowedNetworks.includes(service.network)) rejectReasons.push("NETWORK_NOT_ALLOWED");
  if (service.network !== intent.networkPreference) rejectReasons.push("NETWORK_NOT_ALLOWED");
  const tokenAllowed = policy.allowedTokens.some(
    (token) =>
      token.symbol === service.tokenSymbol &&
      token.address.toLowerCase() === service.tokenAddress.toLowerCase() &&
      token.decimals === service.tokenDecimals,
  );
  if (!tokenAllowed) rejectReasons.push("TOKEN_NOT_ALLOWED");
  if (
    invoiceRequired &&
    (!service.supportsTwInvoice || service.invoiceCapability !== "TW_B2B_DEMO")
  ) {
    rejectReasons.push("INVOICE_REQUIRED");
  }
  if (
    invoiceRequired &&
    (company.businessId !== intent.buyerBusinessId ||
      !isValidTaiwanBusinessId(intent.buyerBusinessId))
  ) {
    rejectReasons.push("BUYER_BUSINESS_ID_INVALID");
  }
  if (livePaymentTerms) {
    if (livePaymentTerms.amountAtomic !== service.priceAtomic) {
      rejectReasons.push("PAYMENT_AMOUNT_MISMATCH");
    }
    if (livePaymentTerms.payToAddress.toLowerCase() !== service.payToAddress.toLowerCase()) {
      rejectReasons.push("PAY_TO_ADDRESS_MISMATCH");
    }
    if (
      livePaymentTerms.network !== service.network ||
      !policy.allowedNetworks.includes(livePaymentTerms.network as typeof service.network)
    ) {
      rejectReasons.push("NETWORK_NOT_ALLOWED");
    }
    const liveTokenAllowed = policy.allowedTokens.some(
      (token) =>
        token.symbol === livePaymentTerms.tokenSymbol &&
        token.address.toLowerCase() === livePaymentTerms.tokenAddress.toLowerCase() &&
        token.decimals === livePaymentTerms.tokenDecimals,
    );
    if (
      !liveTokenAllowed ||
      livePaymentTerms.tokenAddress.toLowerCase() !== service.tokenAddress.toLowerCase() ||
      livePaymentTerms.tokenSymbol !== service.tokenSymbol ||
      livePaymentTerms.tokenDecimals !== service.tokenDecimals
    ) {
      rejectReasons.push("TOKEN_NOT_ALLOWED");
    }
    if (livePaymentTerms.scheme !== "exact" || livePaymentTerms.transferMethod !== "eip3009") {
      rejectReasons.push("PAYMENT_SCHEME_NOT_ALLOWED");
    }
    if (
      expectedFacilitatorUrl &&
      livePaymentTerms.facilitatorUrl !== expectedFacilitatorUrl.replace(/\/$/u, "")
    ) {
      rejectReasons.push("FACILITATOR_NOT_ALLOWED");
    }
  }

  return {
    approved: rejectReasons.length === 0,
    reasonCodes:
      rejectReasons.length > 0
        ? [...new Set(rejectReasons)]
        : [
            "AMOUNT_WITHIN_LIMIT",
            "DAILY_LIMIT_AVAILABLE",
            "SELLER_ALLOWED",
            "NETWORK_ALLOWED",
            "TOKEN_ALLOWED",
            ...(livePaymentTerms ? ["LIVE_PAYMENT_TERMS_VALIDATED"] : []),
            invoiceRequired ? "INVOICE_SUPPORTED" : "INVOICE_NOT_REQUIRED",
          ],
    policyVersion: policy.version,
    evaluatedAt: now.toISOString(),
    expectedAmountAtomic: service.priceAtomic,
    dailySpendBeforeAtomic: dailySettledAtomic,
    dailySpendAfterAtomic: dailyAfter.toString(),
  };
}
