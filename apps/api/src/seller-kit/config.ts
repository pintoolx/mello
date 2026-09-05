import type { Network } from "@x402/core/types";
import { BASE_SEPOLIA_USDC, MELLO_NETWORK, USDC_DECIMALS } from "@mello/shared";
import { z } from "zod";
import type { PaymentMode, SellerServerConfig } from "./types.js";
import { isPublicServiceEndpoint } from "../modules/service-registry/verification.js";

const SellerConfigValuesSchema = z.object({
  sellerId: z.string().regex(/^seller-[a-z0-9-]+$/),
  sellerName: z.string().trim().min(1).max(100),
  port: z.number().int().min(1).max(65_535),
  bindHost: z.string().trim().min(1).optional(),
  publicUrl: z.url(),
  bazaarEnabled: z.boolean().optional(),
  paymentMode: z.enum(["mock", "x402"]),
  facilitatorUrl: z.url(),
  network: z.string().regex(/^[a-z0-9]+:[a-zA-Z0-9-]+$/),
  tokenAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  tokenDecimals: z.number().int().positive(),
  payToAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  priceAtomic: z.string().regex(/^[1-9]\d*$/),
  invoiceCapability: z.enum(["NONE", "TW_B2B_DEMO"]),
  purchaseContextHmacSecret: z.string().min(32).max(4_096),
  maxTimeoutSeconds: z.number().int().positive().optional(),
  idempotencyTtlMs: z.number().int().positive().optional(),
});

const UNSAFE_X402_PAY_TO_ADDRESSES = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x1111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222",
]);
const UNSAFE_CONTEXT_HMAC_SECRET =
  "change-me-with-at-least-32-random-characters";

export function assertSellerServerConfig(
  config: SellerServerConfig,
): SellerServerConfig {
  SellerConfigValuesSchema.parse(config);
  if (config.bazaarEnabled && (config.paymentMode !== "x402" ||
    !isPublicServiceEndpoint(`${config.publicUrl.replace(/\/$/, "")}/v1/credit-report`))) {
    throw new Error("Bazaar publishing requires x402 mode and a public HTTPS seller URL");
  }
  if (
    config.paymentMode === "x402" &&
    UNSAFE_X402_PAY_TO_ADDRESSES.has(config.payToAddress.toLowerCase())
  ) {
    throw new Error(
      `${config.sellerId} requires a non-placeholder payTo address in PAYMENT_MODE=x402`,
    );
  }
  if (config.paymentMode === "x402" && config.network !== MELLO_NETWORK) {
    throw new Error(
      `${config.sellerId} requires ${MELLO_NETWORK} in PAYMENT_MODE=x402`,
    );
  }
  if (
    config.paymentMode === "x402" &&
    config.tokenAddress.toLowerCase() !== BASE_SEPOLIA_USDC.toLowerCase()
  ) {
    throw new Error(
      `${config.sellerId} requires the Base Sepolia Test USDC address in PAYMENT_MODE=x402`,
    );
  }
  if (config.paymentMode === "x402" && config.tokenDecimals !== USDC_DECIMALS) {
    throw new Error(
      `${config.sellerId} requires Test USDC decimals=${USDC_DECIMALS} in PAYMENT_MODE=x402`,
    );
  }
  if (
    config.paymentMode === "x402" &&
    config.purchaseContextHmacSecret === UNSAFE_CONTEXT_HMAC_SECRET
  ) {
    throw new Error(
      `${config.sellerId} requires a non-placeholder purchase-context HMAC secret in PAYMENT_MODE=x402`,
    );
  }
  return config;
}

export function readPaymentMode(value: string | undefined): PaymentMode {
  if (value === undefined || value === "") return "mock";
  if (value === "mock" || value === "x402") return value;
  throw new Error(`Unsupported PAYMENT_MODE: ${value}`);
}

export function readBazaarEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new Error("BAZAAR_PUBLIC_ENABLED must be true or false");
}

export function readNetwork(value: string | undefined, fallback: Network): Network {
  const network = value ?? fallback;
  if (!/^[a-z0-9]+:[a-zA-Z0-9-]+$/.test(network)) {
    throw new Error(`Invalid CAIP-2 network: ${network}`);
  }
  return network as Network;
}

export function readPort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}
