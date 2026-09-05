import { MELLO_CHAIN_ID } from "@mello/shared";

export interface SmokeRuntimeModes {
  payment: unknown;
  anchor: unknown;
  healthStatus?: unknown;
  offchainAuthorizationFallbackEnabled?: unknown;
  baseRpc?: {
    chainId?: unknown;
    loopback?: unknown;
  } | null;
}

export function assertSmokeRuntimeModes(
  modes: SmokeRuntimeModes,
  testnet: boolean,
): void {
  if (testnet) {
    if (modes.payment !== "x402" || modes.anchor !== "onchain") {
      throw new Error(
        "Testnet smoke requires PAYMENT_MODE=x402 and CONTRACT_ANCHOR_MODE=onchain",
      );
    }
    if (modes.healthStatus !== "ok") {
      throw new Error("Testnet smoke requires every dependency health probe to pass");
    }
    if (modes.offchainAuthorizationFallbackEnabled !== false) {
      throw new Error(
        "Testnet smoke refuses DEMO_ALLOW_OFFCHAIN_AUTH; authorization anchoring must fail closed",
      );
    }
    if (
      modes.baseRpc?.chainId !== MELLO_CHAIN_ID ||
      modes.baseRpc.loopback !== false
    ) {
      throw new Error(
        `Testnet smoke requires a non-loopback Base Sepolia RPC reporting chain ID ${MELLO_CHAIN_ID}`,
      );
    }
    return;
  }
  if (modes.payment !== "mock" || modes.anchor !== "mock") {
    throw new Error(
      "Refusing ordinary demo smoke unless both payment and anchor modes are mock; use the explicit testnet command and approval gate for remote on-chain transactions",
    );
  }
}

export function assertTestnetFunding(
  buyerWallet: Record<string, unknown> | null,
  operatorWallet: Record<string, unknown> | null,
  minimumUsdcAtomic = 150_000n,
): void {
  const usdc = buyerWallet?.["usdcBalanceAtomic"];
  if (typeof usdc !== "string" || !/^\d+$/u.test(usdc) || BigInt(usdc) < minimumUsdcAtomic) {
    throw new Error(
      `Testnet smoke requires at least ${minimumUsdcAtomic.toString()} atomic Test USDC before approval`,
    );
  }
  const native = operatorWallet?.["nativeBalanceAtomic"];
  if (typeof native !== "string" || !/^\d+$/u.test(native) || BigInt(native) <= 0n) {
    throw new Error(
      "Testnet smoke requires the contract operator to have a non-zero Base Sepolia ETH gas balance",
    );
  }
}

export function assertRegistryDoesNotHoldFunds(
  registryTokenBalance: Record<string, unknown> | null,
): void {
  const balance = registryTokenBalance?.["balanceAtomic"];
  if (typeof balance !== "string" || !/^\d+$/u.test(balance) || BigInt(balance) !== 0n) {
    throw new Error(
      "Testnet smoke requires the audit registry Test USDC balance to be exactly zero",
    );
  }
}

export interface TestnetTokenBalanceSnapshot {
  blockNumber: bigint;
  buyerBalance: bigint;
  sellerBalance: bigint;
}

export function assertTestnetTokenBalancesUnchanged(
  before: TestnetTokenBalanceSnapshot,
  after: TestnetTokenBalanceSnapshot,
  minimumBlockDelta = 0n,
): void {
  if (after.blockNumber < before.blockNumber + minimumBlockDelta) {
    throw new Error(
      `Testnet rerun token-balance observation covered fewer than ${minimumBlockDelta.toString()} blocks`,
    );
  }
  if (after.buyerBalance !== before.buyerBalance) {
    throw new Error(
      "Completed-task rerun changed the buyer Test USDC balance; a second token transfer may have occurred",
    );
  }
  if (after.sellerBalance !== before.sellerBalance) {
    throw new Error(
      "Completed-task rerun changed the Seller B Test USDC balance; a second token transfer may have occurred",
    );
  }
}
