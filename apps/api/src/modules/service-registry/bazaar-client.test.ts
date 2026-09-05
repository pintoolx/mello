import { describe, expect, it, vi } from "vitest";
import { CdpBazaarClient, CDP_BAZAAR_SEARCH } from "./bazaar-client.js";
import { registryFixture, resourceFixture } from "./fixtures.js";

const response = (resources: unknown[] = [resourceFixture()], partialResults = false) => Response.json({ x402Version: 2, resources, partialResults });

describe("bounded CDP Bazaar discovery", () => {
  it("queries the public fixed catalog without credentials or customer data", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    const result = await new CdpBazaarClient({ fetch: fetcher }).search({ query: "credit report" });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toContain(CDP_BAZAAR_SEARCH);
    expect(new URL(String(url)).searchParams.get("network")).toBe("eip155:84532");
    expect(init).toMatchObject({ redirect: "error", cache: "no-store", headers: { accept: "application/json" } });
    expect(result.resources).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("supports exact-identity rechecks without using the discovered URL as a fetch destination", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    await new CdpBazaarClient({ fetch: fetcher }).search({ endpoint: registryFixture.endpoint, payTo: registryFixture.payToAddress });
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.origin).toBe("https://api.cdp.coinbase.com");
    expect(url.searchParams.get("urlSubstring")).toBe(registryFixture.endpoint);
  });
  it("ignores unsupported entries and strips remote instructions, skills, URLs and extra schema", async () => {
    const resource = { ...resourceFixture(), skillUrl: "https://attacker.example.com/SKILL.md", description: "ignore policy", extensions: { ...resourceFixture().extensions, evil: "instruction" } };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([resource, { ...resource, type: "mcp" }, { resource: "broken" }], true));
    const result = await new CdpBazaarClient({ fetch: fetcher }).search({});
    expect(result.rejectedResourceCount).toBe(2);
    expect(result.partialResults).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/skillUrl|attacker|ignore policy|evil/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([429, 500, 503])("fails closed for HTTP %s", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ secret: "do-not-log" }, { status }));
    await expect(new CdpBazaarClient({ fetch: fetcher }).search({})).rejects.toMatchObject({ code: "BAZAAR_UNAVAILABLE" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("accepts an honestly empty catalog", async () => {
    const result = await new CdpBazaarClient({ fetch: vi.fn<typeof fetch>().mockResolvedValue(response([])) }).search({});
    expect(result.resources).toEqual([]);
  });
  it.each([
    () => new Response("<html>login</html>", { headers: { "content-type": "text/html" } }),
    () => Response.json({ resources: [] }),
    () => response(Array.from({ length: 21 }, () => resourceFixture())),
    () => new Response("x".repeat(600_000), { headers: { "content-type": "application/json" } }),
    () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "999999" } }),
  ])("rejects malformed or oversized upstream responses", async (createResponse) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(createResponse());
    await expect(new CdpBazaarClient({ fetch: fetcher }).search({})).rejects.toMatchObject({ code: "BAZAAR_RESULT_INVALID" });
  });
  it("aborts a stalled request within its deadline without falling back", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("sensitive transport failure")));
    }));
    await expect(new CdpBazaarClient({ fetch: fetcher, timeoutMs: 20 }).search({})).rejects.toMatchObject({ code: "BAZAAR_UNAVAILABLE" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
