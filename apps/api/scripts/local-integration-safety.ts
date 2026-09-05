import { isIP } from "node:net";
import { MELLO_CHAIN_ID } from "@mello/shared";

interface LocalIntegrationTargets {
  coreApiUrl: string;
  sellerAUrl: string;
  sellerBUrl: string;
  baseRpcUrl: string;
}

interface JsonRecord {
  [key: string]: unknown;
}

const REQUIRED_CORE_MODES = {
  agent: "demo",
  payment: "mock",
  invoice: "mock",
  anchor: "onchain",
  offchainAuthorizationFallbackEnabled: false,
} as const;

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Local integration preflight requires ${label}`);
  }
  return value as JsonRecord;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    (isIP(normalized) === 4 && normalized.split(".")[0] === "127")
  );
}

function requireLoopbackHttpUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Local integration preflight requires a valid ${label}`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !isLoopbackHostname(url.hostname)
  ) {
    throw new Error(`Local integration preflight refuses a non-loopback ${label}`);
  }
  return url;
}

function assertHealthyProbe(value: unknown, label: string): JsonRecord {
  const probe = asRecord(value, `${label} health evidence`);
  if (probe["status"] !== "ok") {
    throw new Error(`Local integration preflight requires a healthy ${label}`);
  }
  return probe;
}

export function assertSafeLocalCoreHealth(value: unknown): void {
  const health = asRecord(value, "Core health evidence");
  if (health["status"] !== "ok") {
    throw new Error("Local integration preflight requires an overall healthy Core stack");
  }

  const modes = asRecord(health["modes"], "Core runtime modes");
  for (const [name, required] of Object.entries(REQUIRED_CORE_MODES)) {
    if (modes[name] !== required) {
      throw new Error(
        `Local integration preflight requires Core ${name}=${String(required)}`,
      );
    }
  }

  const checks = asRecord(health["checks"], "Core dependency checks");
  const baseRpc = assertHealthyProbe(checks["baseRpc"], "Base RPC");
  const baseRpcDetails = asRecord(baseRpc["details"], "Base RPC details");
  if (
    baseRpcDetails["chainId"] !== MELLO_CHAIN_ID ||
    baseRpcDetails["loopback"] !== true
  ) {
    throw new Error(
      `Local integration preflight requires loopback Anvil on chain ${MELLO_CHAIN_ID}`,
    );
  }

  const contract = assertHealthyProbe(checks["contract"], "audit contract");
  const contractDetails = asRecord(contract["details"], "audit contract details");
  if (
    contractDetails["mode"] !== "onchain" ||
    contractDetails["codePresent"] !== true
  ) {
    throw new Error(
      "Local integration preflight requires deployed local on-chain audit contract code",
    );
  }
}

export function assertSafeLocalSellerHealth(
  value: unknown,
  expectedSellerId: "seller-a" | "seller-b",
): void {
  const health = asRecord(value, `${expectedSellerId} health evidence`);
  if (
    health["status"] !== "ok" ||
    health["sellerId"] !== expectedSellerId ||
    health["paymentMode"] !== "mock"
  ) {
    throw new Error(
      `Local integration preflight requires ${expectedSellerId} in mock payment mode`,
    );
  }
}

async function fetchHealth(
  baseUrl: URL,
  path: string,
  label: string,
  fetchImplementation: typeof fetch,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImplementation(new URL(path, baseUrl), {
      method: "GET",
      ...(path === "/api/v1/demo/health" && process.env["API_ACCESS_TOKEN"]
        ? { headers: { "x-mello-api-key": process.env["API_ACCESS_TOKEN"] } } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(`Local integration preflight could not reach ${label}`);
  }
  if (!response.ok) {
    throw new Error(`Local integration preflight requires a healthy ${label}`);
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new Error(`Local integration preflight requires JSON from ${label}`);
  }
}

/**
 * Refuses to run the mutating local-stack integration suite unless every target
 * is loopback and the live processes prove they are in the expected no-payment
 * modes with a local Anvil-backed audit contract.
 */
export async function assertSafeLocalIntegrationStack(
  targets: LocalIntegrationTargets,
  fetchImplementation: typeof fetch = fetch,
): Promise<void> {
  const coreApiUrl = requireLoopbackHttpUrl(targets.coreApiUrl, "Core API URL");
  const sellerAUrl = requireLoopbackHttpUrl(targets.sellerAUrl, "Seller A URL");
  const sellerBUrl = requireLoopbackHttpUrl(targets.sellerBUrl, "Seller B URL");
  requireLoopbackHttpUrl(targets.baseRpcUrl, "Base RPC URL");

  const [coreHealth, sellerAHealth, sellerBHealth] = await Promise.all([
    fetchHealth(
      coreApiUrl,
      "/api/v1/demo/health",
      "Core health endpoint",
      fetchImplementation,
    ),
    fetchHealth(sellerAUrl, "/health", "Seller A health endpoint", fetchImplementation),
    fetchHealth(sellerBUrl, "/health", "Seller B health endpoint", fetchImplementation),
  ]);

  assertSafeLocalCoreHealth(coreHealth);
  assertSafeLocalSellerHealth(sellerAHealth, "seller-a");
  assertSafeLocalSellerHealth(sellerBHealth, "seller-b");
}
