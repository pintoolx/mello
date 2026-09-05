import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
} from "@x402/core/types";
import {
  declarePaymentIdentifierExtension,
  extractAndValidatePaymentIdentifier,
  PAYMENT_IDENTIFIER,
} from "@x402/extensions/payment-identifier";
import type { SellerServerConfig } from "./types.js";

export {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";

export const CREDIT_REPORT_ROUTE = "/v1/credit-report" as const;

export function createPaymentRequirements(
  config: SellerServerConfig,
): PaymentRequirements {
  return {
    scheme: "exact",
    network: config.network,
    asset: config.tokenAddress,
    amount: config.priceAtomic,
    payTo: config.payToAddress,
    maxTimeoutSeconds: config.maxTimeoutSeconds ?? 300,
    extra: {
      name: "USDC",
      version: "2",
      assetTransferMethod: "eip3009",
      assetDecimals: config.tokenDecimals,
      facilitator: config.facilitatorUrl.replace(/\/$/u, ""),
    },
  };
}

export function createRouteExtensions(
  config: SellerServerConfig,
): Record<string, unknown> {
  return {
    ...(config.routeExtensions ?? {}),
    [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(true),
  };
}

export function createMockPaymentRequired(
  config: SellerServerConfig,
): PaymentRequired {
  return {
    x402Version: 2,
    error: "Payment required",
    resource: {
      url: `${config.publicUrl.replace(/\/$/, "")}${CREDIT_REPORT_ROUTE}`,
      description: `${config.sellerName} demo credit report`,
      mimeType: "application/json",
      serviceName: config.sellerName,
      tags: ["credit-report", "demo"],
    },
    accepts: [createPaymentRequirements(config)],
    extensions: createRouteExtensions(config),
  };
}

export function encodeMockPaymentRequired(
  config: SellerServerConfig,
): string {
  return encodePaymentRequiredHeader(createMockPaymentRequired(config));
}

export type PaymentIdentifierExtraction =
  | { ok: true; paymentId: string; payload: PaymentPayload }
  | { ok: false; code: "INVALID_PAYMENT_SIGNATURE" | "PAYMENT_IDENTIFIER_REQUIRED" };

export function extractRequiredPaymentIdentifier(
  paymentSignatureHeader: string,
): PaymentIdentifierExtraction {
  let payload: PaymentPayload;
  try {
    payload = decodePaymentSignatureHeader(paymentSignatureHeader);
  } catch {
    return { ok: false, code: "INVALID_PAYMENT_SIGNATURE" };
  }

  const { id, validation } = extractAndValidatePaymentIdentifier(payload);
  if (!validation.valid || !id) {
    return { ok: false, code: "PAYMENT_IDENTIFIER_REQUIRED" };
  }
  return { ok: true, paymentId: id, payload };
}

export function createMockSettlementResponse(
  config: SellerServerConfig,
  paymentId: string,
): SettleResponse {
  const suffix = paymentId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return {
    success: true,
    payer: "mock-buyer",
    transaction: `mock:${config.sellerId}:${suffix}`,
    network: config.network,
    amount: config.priceAtomic,
    ...(config.settlementExtensions
      ? { extensions: { ...config.settlementExtensions } }
      : {}),
    extra: {
      paymentMode: "mock",
      paymentId,
    },
  };
}

export function encodeMockSettlement(
  config: SellerServerConfig,
  paymentId: string,
): string {
  return encodePaymentResponseHeader(
    createMockSettlementResponse(config, paymentId),
  );
}

export function paymentTermsFromPayload(
  payload: PaymentPayload,
): PaymentRequirements {
  return payload.accepted;
}
