import { isIP } from "node:net";
import type { AppConfig } from "./config.js";
import type {
  AnchorTransactionResult,
  AuditAnchorClient,
} from "@mello/contracts-client";
import { BASE_SEPOLIA_USDC, MELLO_NETWORK } from "@mello/shared";
import type { PaymentSettlement } from "./modules/x402-buyer/payment-provider.js";

export interface PurchaseRuntimeEvidence {
  agentMode: string;
  paymentMode: string;
  invoiceMode: string;
  anchorMode: string;
  paymentExplorerBase: string | null;
  anchorExplorerBase: string | null;
}

function rpcUrlIsLoopback(rpcUrl: string): boolean {
  try {
    const hostname = new URL(rpcUrl).hostname
      .toLowerCase()
      .replace(/^\[|\]$/gu, "")
      .replace(/\.$/u, "");
    return (
      hostname === "localhost" ||
      hostname === "::1" ||
      (isIP(hostname) === 4 && hostname.split(".")[0] === "127")
    );
  } catch {
    return false;
  }
}

/** Captures immutable display provenance before any payment or anchor is attempted. */
export function capturePurchaseRuntimeEvidence(
  config: Pick<
    AppConfig,
    | "AGENT_MODE"
    | "PAYMENT_MODE"
    | "INVOICE_PROVIDER"
    | "CONTRACT_ANCHOR_MODE"
    | "BASE_SEPOLIA_RPC_URL"
    | "BASESCAN_BASE_URL"
  >,
): PurchaseRuntimeEvidence {
  return {
    agentMode: config.AGENT_MODE,
    paymentMode: config.PAYMENT_MODE,
    invoiceMode: config.INVOICE_PROVIDER,
    anchorMode: config.CONTRACT_ANCHOR_MODE,
    // Modes and URL shapes are not chain provenance. Explorer links are added
    // only after the corresponding runtime evidence is independently checked.
    paymentExplorerBase: null,
    anchorExplorerBase: null,
  };
}

export function paymentExplorerBaseForVerifiedSettlement(
  config: Pick<
    AppConfig,
    "PAYMENT_MODE" | "BASE_SEPOLIA_RPC_URL" | "BASESCAN_BASE_URL"
  >,
  settlement: Pick<
    PaymentSettlement,
    "network" | "tokenAddress" | "transactionHash" | "verifiedChainId"
  >,
): string | null {
  if (
    config.PAYMENT_MODE !== "x402" ||
    settlement.verifiedChainId !== 84_532 ||
    rpcUrlIsLoopback(config.BASE_SEPOLIA_RPC_URL) ||
    settlement.network !== MELLO_NETWORK ||
    settlement.tokenAddress.toLowerCase() !== BASE_SEPOLIA_USDC.toLowerCase() ||
    !/^0x[a-fA-F0-9]{64}$/u.test(settlement.transactionHash)
  ) {
    return null;
  }
  return config.BASESCAN_BASE_URL.replace(/\/$/u, "");
}

/**
 * Adds BaseScan provenance only after the real on-chain client has returned a
 * successful receipt. Mock/disabled clients deliberately keep hashes unlinkable.
 */
export function anchorExplorerBaseForVerifiedConfirmation(
  config: Pick<AppConfig, "BASE_SEPOLIA_RPC_URL" | "BASESCAN_BASE_URL">,
  anchorMode: AuditAnchorClient["mode"],
  result: AnchorTransactionResult,
): string | null {
  if (
    anchorMode !== "onchain" ||
    result.chainId !== 84_532 ||
    rpcUrlIsLoopback(config.BASE_SEPOLIA_RPC_URL) ||
    !/^0x[a-fA-F0-9]{64}$/u.test(result.transactionHash) ||
    result.blockNumber <= 0n
  ) {
    return null;
  }
  return config.BASESCAN_BASE_URL.replace(/\/$/u, "");
}
