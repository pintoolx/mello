import type {
  Network,
  PaymentRequirements,
  ResourceServerExtension,
} from "@x402/core/types";

export type PaymentMode = "mock" | "x402";
export type InvoiceCapability = "NONE" | "TW_B2B_DEMO";

export interface SellerServerConfig {
  sellerId: string;
  sellerName: string;
  port: number;
  bindHost?: string;
  publicUrl: string;
  bazaarEnabled?: boolean;
  paymentMode: PaymentMode;
  facilitatorUrl: string;
  network: Network;
  tokenAddress: string;
  tokenDecimals: number;
  payToAddress: string;
  priceAtomic: string;
  invoiceCapability: InvoiceCapability;
  purchaseContextHmacSecret: string;
  maxTimeoutSeconds?: number;
  idempotencyTtlMs?: number;
  routeExtensions?: Readonly<Record<string, unknown>>;
  settlementExtensions?: Readonly<Record<string, unknown>>;
  resourceServerExtensions?: readonly ResourceServerExtension[];
  clock?: () => Date;
}

export interface LegacyCreditReportRequest {
  targetCompanyName: string;
  purchaseContextToken?: string | undefined;
}

export type MarketServiceCategory = "stock_analysis" | "macro_analysis" | "crypto_market" | "futures_analysis";

export interface MarketReportRequest {
  serviceId: string;
  serviceCategory: MarketServiceCategory;
  serviceQuery: string;
  purchaseContextToken?: string | undefined;
}

export type CreditReportRequest = LegacyCreditReportRequest | MarketReportRequest;

export interface LegacyCreditReport {
  reportId: string;
  provider: string;
  targetCompanyName: string;
  riskScore: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  summary: "Demo credit report only";
  generatedAt: string;
  paymentMode: PaymentMode;
  isDemo: true;
}

export interface MarketReport {
  reportVersion: "market-v1";
  reportId: string;
  provider: string;
  serviceId: string;
  serviceCategory: MarketServiceCategory;
  serviceQuery: string;
  title: string;
  summary: string;
  sections: Array<{ title: string; points: string[] }>;
  generatedAt: string;
  paymentMode: PaymentMode;
  isDemo: true;
  disclaimer: "模擬研究內容，非即時市場資料，亦非投資建議。";
}

export type CreditReport = LegacyCreditReport | MarketReport;

export interface FingerprintInput {
  sellerId: string;
  method: string;
  path: string;
  body: unknown;
  requirements: Pick<
    PaymentRequirements,
    | "scheme"
    | "network"
    | "asset"
    | "amount"
    | "payTo"
    | "maxTimeoutSeconds"
    | "extra"
  >;
  /** Hash of the complete signed x402 payload. Never persist the raw signature. */
  paymentPayloadHash?: string;
}

export interface CachedSellerResponse {
  fingerprint: string;
  statusCode: number;
  body: unknown;
  createdAtMs: number;
  paymentResponseHeader: string;
}

export type CacheLookup =
  | { kind: "miss" }
  | { kind: "hit"; entry: CachedSellerResponse }
  | { kind: "conflict"; fingerprint: string }
  | { kind: "processing"; retryAfterMs: number };

export type IdempotencyClaim =
  | { kind: "acquired"; claimToken: string }
  | { kind: "hit"; entry: CachedSellerResponse }
  | { kind: "conflict"; fingerprint: string }
  | { kind: "processing"; retryAfterMs: number };

export interface SellerIdempotencyStore {
  claim(
    sellerId: string,
    method: string,
    path: string,
    paymentId: string,
    fingerprint: string,
  ): Promise<IdempotencyClaim>;
  lookup(
    sellerId: string,
    method: string,
    path: string,
    paymentId: string,
    fingerprint: string,
  ): Promise<CacheLookup>;
  /**
   * Durably fences a verified request immediately before the external
   * settlement call. A fenced claim must never be lease-reclaimed because the
   * outcome of that call can become ambiguous across process/network failure.
   */
  beginSettlement(
    sellerId: string,
    method: string,
    path: string,
    paymentId: string,
    fingerprint: string,
    claimToken: string,
  ): Promise<void>;
  complete(
    sellerId: string,
    method: string,
    path: string,
    paymentId: string,
    claimToken: string,
    entry: Omit<CachedSellerResponse, "createdAtMs">,
  ): Promise<CachedSellerResponse>;
}
