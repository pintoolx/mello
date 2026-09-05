import { describe, expect, it, vi } from "vitest";
import {
  assertSafeLocalCoreHealth,
  assertSafeLocalIntegrationStack,
} from "./local-integration-safety.js";

const TARGETS = {
  coreApiUrl: "http://127.0.0.1:4000",
  sellerAUrl: "http://localhost:4011",
  sellerBUrl: "http://[::1]:4012",
  baseRpcUrl: "http://127.0.0.1:8545",
};

function coreHealth(overrides: {
  payment?: string;
  anchor?: string;
  rpcLoopback?: boolean;
} = {}): Record<string, unknown> {
  const anchor = overrides.anchor ?? "onchain";
  return {
    status: "ok",
    modes: {
      agent: "demo",
      payment: overrides.payment ?? "mock",
      invoice: "mock",
      anchor,
      offchainAuthorizationFallbackEnabled: false,
    },
    checks: {
      baseRpc: {
        status: "ok",
        details: { chainId: 84_532, loopback: overrides.rpcLoopback ?? true },
      },
      contract: {
        status: "ok",
        details: { mode: anchor, codePresent: true },
      },
    },
  };
}

function sellerHealth(sellerId: "seller-a" | "seller-b"): Record<string, unknown> {
  return { status: "ok", sellerId, paymentMode: "mock" };
}

function healthFetch(core: unknown = coreHealth()): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes(":4000/")) return Response.json(core);
    if (url.includes(":4011/")) return Response.json(sellerHealth("seller-a"));
    if (url.includes(":4012/")) return Response.json(sellerHealth("seller-b"));
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

describe("local integration safety", () => {
  it("accepts a fully healthy loopback mock-payment stack with local anchors", async () => {
    const fetchImplementation = healthFetch();

    await expect(
      assertSafeLocalIntegrationStack(TARGETS, fetchImplementation),
    ).resolves.toBeUndefined();
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["Core", { ...TARGETS, coreApiUrl: "https://core.example.com" }],
    ["Core lookalike", { ...TARGETS, coreApiUrl: "http://127.example.com:4000" }],
    ["Seller A", { ...TARGETS, sellerAUrl: "https://seller-a.example.com" }],
    ["Seller B", { ...TARGETS, sellerBUrl: "https://seller-b.example.com" }],
    ["Base RPC", { ...TARGETS, baseRpcUrl: "https://sepolia.base.org" }],
  ])("refuses a non-loopback %s target before any request", async (_label, targets) => {
    const fetchImplementation = healthFetch();

    await expect(
      assertSafeLocalIntegrationStack(targets, fetchImplementation),
    ).rejects.toThrow("non-loopback");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("refuses live x402 mode before a task can be created", async () => {
    await expect(
      assertSafeLocalIntegrationStack(
        TARGETS,
        healthFetch(coreHealth({ payment: "x402" })),
      ),
    ).rejects.toThrow("payment=mock");
  });

  it("refuses remote RPC evidence even when the configured URL says loopback", async () => {
    expect(() =>
      assertSafeLocalCoreHealth(coreHealth({ rpcLoopback: false })),
    ).toThrow("loopback Anvil");
  });

  it("refuses mock anchors because the suite asserts real local receipts", async () => {
    expect(() => assertSafeLocalCoreHealth(coreHealth({ anchor: "mock" }))).toThrow(
      "anchor=onchain",
    );
  });
});
