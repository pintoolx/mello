import { describe, expect, it, vi } from "vitest";
import { assertBaseSepoliaDeployTarget } from "./forge-safety.js";

describe("Forge broadcast safety", () => {
  it("accepts only a non-loopback RPC that reports Base Sepolia", async () => {
    const fetchImplementation = vi.fn(async () =>
      Response.json({ jsonrpc: "2.0", id: 1, result: "0x14a34" }),
    );
    await expect(
      assertBaseSepoliaDeployTarget(
        "https://sepolia.base.org",
        fetchImplementation as typeof fetch,
      ),
    ).resolves.toBeUndefined();
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("refuses loopback and wrong-chain targets before a broadcast", async () => {
    const fetchImplementation = vi.fn(async () =>
      Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" }),
    );
    for (const rpcUrl of [
      "http://127.0.0.1:8545",
      "http://127.0.0.2:8545",
      "http://127.1:8545",
      "http://[::1]:8545",
      "http://localhost.:8545",
    ]) {
      await expect(
        assertBaseSepoliaDeployTarget(rpcUrl, fetchImplementation as typeof fetch),
      ).rejects.toThrow("loopback");
    }
    expect(fetchImplementation).not.toHaveBeenCalled();
    await expect(
      assertBaseSepoliaDeployTarget(
        "https://wrong-chain.example",
        fetchImplementation as typeof fetch,
      ),
    ).rejects.toThrow("expected Base Sepolia 84532");
  });
});
