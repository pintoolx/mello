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
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { MARKET_SERVICE_CATALOG } from "@mello/shared";

export {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";

export const CREDIT_REPORT_ROUTE = "/v1/credit-report" as const;

export function sellerResourceMetadata(config: SellerServerConfig) {
  const offerings = MARKET_SERVICE_CATALOG.filter((service) => service.sellerId === config.sellerId);
  const serviceName = offerings.map((service) => service.displayName).join("、") || "Demo credit report";
  return {
    description: `${offerings[0]?.sellerDisplayName ?? config.sellerName}：${serviceName}（Demo；保留 legacy credit report）`,
    serviceName,
    tags: ["market-analysis", ...offerings.flatMap((service) => [service.id, service.bazaarQuery]), "credit-report", "demo"],
  };
}

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
  const offerings = MARKET_SERVICE_CATALOG.filter((service) => service.sellerId === config.sellerId);
  const sample = offerings[0];
  return {
    ...(config.routeExtensions ?? {}),
    ...(config.bazaarEnabled ? declareDiscoveryExtension({
      // The pinned x402 SDK enriches method from the POST route at runtime.
      bodyType: "json",
      input: sample ? { serviceId: sample.id, serviceCategory: sample.category, serviceQuery: sample.displayName }
        : { targetCompanyName: "Example Co." },
      inputSchema: {
        oneOf: [
          ...offerings.map((service) => ({
            type: "object", properties: {
              serviceId: { type: "string", const: service.id },
              serviceCategory: { type: "string", const: service.category },
              serviceQuery: { type: "string", minLength: 1, maxLength: 200 },
              purchaseContextToken: { type: "string", minLength: 16, maxLength: 4096 },
            }, required: ["serviceId", "serviceCategory", "serviceQuery"], additionalProperties: false,
          })),
          { type: "object", properties: {
            targetCompanyName: { type: "string", minLength: 1, maxLength: 200 },
            purchaseContextToken: { type: "string", description: "Optional Mello correlation token. Not required for public purchases.", minLength: 16, maxLength: 4096 },
          }, required: ["targetCompanyName"], additionalProperties: false },
        ],
      },
      output: { example: sample ? {
        reportVersion: "market-v1", reportId: "rpt_00000000000000000000", provider: config.sellerId,
        serviceId: sample.id, serviceCategory: sample.category, serviceQuery: sample.displayName,
        title: sample.displayName, summary: sample.description,
        sections: [{ title: "研究重點（Demo）", points: ["模擬研究資訊；未引用即時行情。"] }],
        generatedAt: "2026-09-05T00:00:00.000Z", paymentMode: "x402", isDemo: true,
        disclaimer: "模擬研究內容，非即時市場資料，亦非投資建議。",
      } : {
        reportId: "rpt_00000000000000000000", provider: config.sellerId,
        targetCompanyName: "Example Co.", riskScore: 50, riskLevel: "MEDIUM",
        summary: "Demo credit report only", generatedAt: "2026-09-05T00:00:00.000Z",
        paymentMode: "x402", isDemo: true,
      } },
    }) : {}),
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
      ...sellerResourceMetadata(config),
      mimeType: "application/json",
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
