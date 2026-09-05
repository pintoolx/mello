import { describe, expect, it } from "vitest";
import { BASE_SEPOLIA_USDC, MELLO_NETWORK } from "@mello/shared";
import {
  anchorExplorerBaseForVerifiedConfirmation,
  capturePurchaseRuntimeEvidence,
  paymentExplorerBaseForVerifiedSettlement,
} from "./runtime-evidence.js";

const base = {
  AGENT_MODE: "demo" as const,
  PAYMENT_MODE: "x402" as const,
  INVOICE_PROVIDER: "mock" as const,
  CONTRACT_ANCHOR_MODE: "onchain" as const,
  BASE_SEPOLIA_RPC_URL: "https://sepolia.base.org",
  BASESCAN_BASE_URL: "https://sepolia.basescan.org/",
};

describe("purchase runtime evidence", () => {
  it("does not infer explorer provenance from modes or a non-local RPC URL", () => {
    expect(capturePurchaseRuntimeEvidence(base)).toMatchObject({
      paymentMode: "x402",
      anchorMode: "onchain",
      paymentExplorerBase: null,
      anchorExplorerBase: null,
    });
  });

  it("never gives local Anvil or mock hashes a BaseScan provenance", () => {
    expect(
      capturePurchaseRuntimeEvidence({
        ...base,
        PAYMENT_MODE: "mock",
        BASE_SEPOLIA_RPC_URL: "http://127.0.0.1:8545",
      }),
    ).toMatchObject({
      paymentExplorerBase: null,
      anchorExplorerBase: null,
    });
  });

  it("adds payment explorer provenance only for verified Base Sepolia Test USDC evidence", () => {
    const settlement = {
      network: MELLO_NETWORK,
      tokenAddress: BASE_SEPOLIA_USDC,
      transactionHash: `0x${"1".repeat(64)}` as `0x${string}`,
      verifiedChainId: 84_532,
    };
    expect(paymentExplorerBaseForVerifiedSettlement(base, settlement)).toBe(
      "https://sepolia.basescan.org",
    );
    expect(
      paymentExplorerBaseForVerifiedSettlement(
        { ...base, PAYMENT_MODE: "mock" },
        settlement,
      ),
    ).toBeNull();
    expect(
      paymentExplorerBaseForVerifiedSettlement(base, {
        ...settlement,
        tokenAddress: "0x1111111111111111111111111111111111111111",
      }),
    ).toBeNull();
    expect(
      paymentExplorerBaseForVerifiedSettlement(base, {
        ...settlement,
        verifiedChainId: 1,
      }),
    ).toBeNull();
    expect(
      paymentExplorerBaseForVerifiedSettlement(
        { ...base, BASE_SEPOLIA_RPC_URL: "http://127.0.0.1:8545" },
        settlement,
      ),
    ).toBeNull();
    for (const localRpc of [
      "http://127.0.0.2:8545",
      "http://localhost.:8545",
      "http://[::1]:8545",
    ]) {
      expect(
        paymentExplorerBaseForVerifiedSettlement(
          { ...base, BASE_SEPOLIA_RPC_URL: localRpc },
          settlement,
        ),
      ).toBeNull();
    }
  });

  it("adds anchor explorer provenance only after an on-chain receipt is confirmed", () => {
    const result = {
      transactionHash: `0x${"2".repeat(64)}` as `0x${string}`,
      blockNumber: 123n,
      chainId: 84_532,
    };
    expect(anchorExplorerBaseForVerifiedConfirmation(base, "onchain", result)).toBe(
      "https://sepolia.basescan.org",
    );
    expect(anchorExplorerBaseForVerifiedConfirmation(base, "mock", result)).toBeNull();
    expect(
      anchorExplorerBaseForVerifiedConfirmation(
        { ...base, BASE_SEPOLIA_RPC_URL: "http://127.0.0.1:8545" },
        "onchain",
        result,
      ),
    ).toBeNull();
    for (const localRpc of [
      "http://127.0.0.2:8545",
      "http://localhost.:8545",
      "http://[::1]:8545",
    ]) {
      expect(
        anchorExplorerBaseForVerifiedConfirmation(
          { ...base, BASE_SEPOLIA_RPC_URL: localRpc },
          "onchain",
          result,
        ),
      ).toBeNull();
    }
    expect(
      anchorExplorerBaseForVerifiedConfirmation(base, "onchain", {
        ...result,
        chainId: 1,
      }),
    ).toBeNull();
    expect(
      anchorExplorerBaseForVerifiedConfirmation(base, "onchain", {
        ...result,
        blockNumber: 0n,
      }),
    ).toBeNull();
  });
});
