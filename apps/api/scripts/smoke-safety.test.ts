import { describe, expect, it } from "vitest";
import {
  assertRegistryDoesNotHoldFunds,
  assertSmokeRuntimeModes,
  assertTestnetFunding,
  assertTestnetTokenBalancesUnchanged,
} from "./smoke-safety.js";

describe("demo smoke side-effect guard", () => {
  it("permits only the all-mock ordinary smoke", () => {
    expect(() =>
      assertSmokeRuntimeModes({ payment: "mock", anchor: "mock" }, false),
    ).not.toThrow();
    expect(() =>
      assertSmokeRuntimeModes({ payment: "mock", anchor: "onchain" }, false),
    ).toThrow("both payment and anchor modes are mock");
  });

  it("requires both real testnet modes for the opt-in smoke", () => {
    expect(() =>
      assertSmokeRuntimeModes(
        {
          payment: "x402",
          anchor: "onchain",
          healthStatus: "ok",
          offchainAuthorizationFallbackEnabled: false,
          baseRpc: { chainId: 84_532, loopback: false },
        },
        true,
      ),
    ).not.toThrow();
    expect(() =>
      assertSmokeRuntimeModes({ payment: "mock", anchor: "onchain" }, true),
    ).toThrow("Testnet smoke requires");
    expect(() =>
      assertSmokeRuntimeModes(
        {
          payment: "x402",
          anchor: "onchain",
          healthStatus: "degraded",
          offchainAuthorizationFallbackEnabled: false,
          baseRpc: { chainId: 84_532, loopback: false },
        },
        true,
      ),
    ).toThrow("health probe");
    expect(() =>
      assertSmokeRuntimeModes(
        {
          payment: "x402",
          anchor: "onchain",
          healthStatus: "ok",
          offchainAuthorizationFallbackEnabled: true,
          baseRpc: { chainId: 84_532, loopback: false },
        },
        true,
      ),
    ).toThrow("DEMO_ALLOW_OFFCHAIN_AUTH");
  });

  it.each([
    ["a loopback chain reporting 84532", { chainId: 84_532, loopback: true }],
    ["a non-Base-Sepolia chain", { chainId: 1, loopback: false }],
    ["missing RPC provenance", null],
  ])("rejects %s for the opt-in testnet smoke", (_label, baseRpc) => {
    expect(() =>
      assertSmokeRuntimeModes(
        {
          payment: "x402",
          anchor: "onchain",
          healthStatus: "ok",
          offchainAuthorizationFallbackEnabled: false,
          baseRpc,
        },
        true,
      ),
    ).toThrow("non-loopback Base Sepolia RPC");
  });

  it("requires buyer Test USDC and a funded contract operator, not buyer gas", () => {
    expect(() =>
      assertTestnetFunding(
        { usdcBalanceAtomic: "150000", nativeBalanceAtomic: "0" },
        { nativeBalanceAtomic: "1" },
      ),
    ).not.toThrow();
    expect(() =>
      assertTestnetFunding(
        { usdcBalanceAtomic: "149999", nativeBalanceAtomic: "999" },
        { nativeBalanceAtomic: "1" },
      ),
    ).toThrow("at least 150000");
    expect(() =>
      assertTestnetFunding(
        { usdcBalanceAtomic: "150000", nativeBalanceAtomic: "999" },
        { nativeBalanceAtomic: "0" },
      ),
    ).toThrow("contract operator");
  });

  it("requires the audit registry to hold exactly zero Test USDC", () => {
    expect(() =>
      assertRegistryDoesNotHoldFunds({ balanceAtomic: "0" }),
    ).not.toThrow();
    expect(() =>
      assertRegistryDoesNotHoldFunds({ balanceAtomic: "1" }),
    ).toThrow("exactly zero");
    expect(() => assertRegistryDoesNotHoldFunds(null)).toThrow("exactly zero");
  });

  it("proves a completed-task rerun did not move buyer or Seller B Test USDC", () => {
    const before = {
      blockNumber: 100n,
      buyerBalance: 150_000n,
      sellerBalance: 50_000n,
    };

    expect(() =>
      assertTestnetTokenBalancesUnchanged(
        before,
        { ...before, blockNumber: 102n },
        2n,
      ),
    ).not.toThrow();
    expect(() =>
      assertTestnetTokenBalancesUnchanged(
        before,
        { ...before, blockNumber: 102n, buyerBalance: 100_000n },
        2n,
      ),
    ).toThrow("buyer Test USDC balance");
    expect(() =>
      assertTestnetTokenBalancesUnchanged(
        before,
        { ...before, blockNumber: 102n, sellerBalance: 100_000n },
        2n,
      ),
    ).toThrow("Seller B Test USDC balance");
    expect(() =>
      assertTestnetTokenBalancesUnchanged(
        before,
        { ...before, blockNumber: 101n },
        2n,
      ),
    ).toThrow("fewer than 2 blocks");
  });
});
