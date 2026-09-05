import { describe, expect, it, vi } from "vitest";
import { MARKET_SERVICE_CATALOG, serviceDiscoveryQuery, type ServiceRecord } from "@mello/shared";
import { CDP_BAZAAR_SEARCH, CdpBazaarClient, type BazaarResource } from "./bazaar-client.js";
import { registryFixture, resourceFixture, resultFixture, reviewFixture, reviewNow } from "./fixtures.js";
import { assessDiscovery, matchingBazaarResource, ServiceRegistry } from "./registry-service.js";

const queries = {
  stock_analysis: "stock analysis", macro_analysis: "macroeconomic analysis",
  crypto_market: "crypto market information", futures_analysis: "futures analysis", credit_report: "credit report",
} as const;
const services: ServiceRecord[] = [...MARKET_SERVICE_CATALOG.map((product) => ({
  ...registryFixture, id: product.id, category: product.category, sellerId: product.sellerId,
  sellerLegalName: `Synthetic ${product.sellerId}`, priceAtomic: product.priceAtomic,
  endpoint: `https://${product.sellerId}.example.com/v1/credit-report`,
  payToAddress: product.sellerId === "seller-a" ? "0x2222222222222222222222222222222222222222" : registryFixture.payToAddress,
  invoiceCapability: product.supportsTwInvoice ? "TW_B2B_DEMO" as const : "NONE" as const,
  supportsTwInvoice: product.supportsTwInvoice,
})), registryFixture];
const market = services.find((service) => service.category === "crypto_market")!;

function advertised(service: ServiceRecord): BazaarResource {
  const resource = resourceFixture(service);
  if (service.category !== "credit_report") {
    resource.extensions.bazaar.schema = { properties: { input: { properties: { body: { oneOf: [{
      type: "object", properties: {
        serviceId: { type: "string", const: service.id },
        serviceCategory: { type: "string", const: service.category },
        serviceQuery: { type: "string", minLength: 1, maxLength: 200 },
      }, required: ["serviceId", "serviceCategory", "serviceQuery"], additionalProperties: false,
    }] } } } } };
  }
  return resource;
}

function response(resources: BazaarResource[]) {
  return Response.json({ x402Version: 2, resources, partialResults: false });
}

function fixture(service = market) {
  const current = advertised(service);
  const record = { ...service, verification: reviewFixture(service), seller: {
    legalName: service.sellerLegalName, businessId: service.sellerBusinessId, payToAddress: service.payToAddress,
    invoiceCapability: service.invoiceCapability, invoiceProvider: service.invoiceProvider, status: "ACTIVE",
  } };
  const findUnique = vi.fn().mockImplementation(async () => record);
  const findMany = vi.fn().mockRejectedValue(new Error("Local catalog fallback is forbidden"));
  // Simulate a public index with stale endpoint-only results. No actual network
  // or Prisma client is used; only the canonical category query returns current input metadata.
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = new URL(String(input));
    return response([url.searchParams.get("query") === queries[service.category] ? current : resourceFixture(service)]);
  });
  const client = new CdpBazaarClient({ fetch: fetcher, now: () => reviewNow });
  const registry = new ServiceRegistry({ service: { findUnique, findMany } } as never, client, () => reviewNow);
  const evidence = assessDiscovery(service, record.verification, resultFixture([current]), reviewNow).evidence;
  if (!evidence) throw new Error("Invalid synthetic discovery evidence");
  return { service, current, record, findUnique, findMany, fetcher, client, registry, evidence };
}

describe("category-aware purchase-time Bazaar recheck", () => {
  it.each(services)("rechecks $category with its canonical query AND exact endpoint/payTo", async (service) => {
    const h = fixture(service);
    await expect(h.registry.assertPurchasable(service.id, h.evidence)).resolves.toBeUndefined();
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    const [input, options] = h.fetcher.mock.calls[0]!;
    const url = new URL(String(input));
    expect(`${url.origin}${url.pathname}`).toBe(CDP_BAZAAR_SEARCH);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      network: service.network, asset: service.tokenAddress, scheme: "exact", limit: "20",
      query: queries[service.category], urlSubstring: service.endpoint, payTo: service.payToAddress,
    });
    expect(serviceDiscoveryQuery(service.category)).toBe(queries[service.category]);
    expect(options).toMatchObject({ redirect: "error", cache: "no-store", headers: { accept: "application/json" } });
    expect(h.findUnique).toHaveBeenCalledTimes(2);
    expect(h.findMany).not.toHaveBeenCalled();
  });

  it.each(services.filter((service) => service.category !== "credit_report"))(
    "does not confuse stale credit metadata at the same endpoint with $category", async (service) => {
      const h = fixture(service);
      const stale = await h.client.search({ endpoint: service.endpoint, payTo: service.payToAddress });
      expect(stale.resources[0]?.resource).toBe(service.endpoint);
      expect(stale.resources[0]?.accepts[0]?.payTo).toBe(service.payToAddress);
      expect(matchingBazaarResource(service, stale.resources[0]!)).toBe(false);
      await expect(h.registry.assertPurchasable(service.id, h.evidence)).resolves.toBeUndefined();
      expect(h.fetcher).toHaveBeenCalledTimes(2);
      expect(new URL(String(h.fetcher.mock.calls[1]![0])).searchParams.get("query")).toBe(queries[service.category]);
    },
  );

  it.each([
    ["amount", "40000"], ["payTo", "0x4444444444444444444444444444444444444444"],
    ["network", "eip155:8453"], ["asset", "0x5555555555555555555555555555555555555555"],
    ["scheme", "upto"],
  ] as const)("still rejects a changed %s with the correct category query", async (key, value) => {
    const h = fixture();
    h.current.accepts[0]![key] = value;
    await expect(h.registry.assertPurchasable(h.service.id, h.evidence)).rejects.toMatchObject({ code: "BAZAAR_SERVICE_NOT_FOUND" });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(h.findUnique).toHaveBeenCalledTimes(1);
    expect(h.findMany).not.toHaveBeenCalled();
  });

  it.each(["endpoint", "method", "legacy schema", "wrong service ID", "wrong category"])(
    "does not relax the %s match after adding a category query", async (change) => {
      const h = fixture();
      if (change === "endpoint") h.current.resource += "/different";
      if (change === "method") h.current.extensions.bazaar.info.input.method = "GET";
      if (change === "legacy schema") delete h.current.extensions.bazaar.schema;
      if (change === "wrong service ID" || change === "wrong category") {
        const changed = advertised({ ...h.service,
          ...(change === "wrong service ID" ? { id: "macro-analysis" } : { category: "macro_analysis" as const }),
        });
        h.current.extensions.bazaar.schema = changed.extensions.bazaar.schema;
      }
      await expect(h.registry.assertPurchasable(h.service.id, h.evidence)).rejects.toMatchObject({ code: "BAZAAR_SERVICE_NOT_FOUND" });
      expect(h.fetcher).toHaveBeenCalledTimes(1);
      expect(h.findMany).not.toHaveBeenCalled();
    },
  );

  it.each(["before", "during"] as const)("rechecks certification %s the public query", async (phase) => {
    const h = fixture();
    const revoke = () => { h.record.verification.status = "REVOKED"; h.record.verification.revokedAt = reviewNow; };
    if (phase === "before") revoke();
    else h.fetcher.mockImplementationOnce(async () => { revoke(); return response([h.current]); });
    await expect(h.registry.assertPurchasable(h.service.id, h.evidence)).rejects.toMatchObject({ code: "SERVICE_VERIFICATION_REQUIRED" });
    expect(h.fetcher).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
    expect(h.findUnique).toHaveBeenCalledTimes(phase === "before" ? 1 : 2);
  });

  it.each(["expiry", "revision", "price", "binding", "inactive"] as const)(
    "rejects %s changes while the category-aware query is in flight", async (change) => {
      const h = fixture();
      h.fetcher.mockImplementationOnce(async () => {
        if (change === "expiry") h.record.verification.expiresAt = reviewNow;
        if (change === "revision") h.record.verification.revision += 1;
        if (change === "price") h.record.priceAtomic = "60000";
        if (change === "binding") h.record.seller.payToAddress = "0x6666666666666666666666666666666666666666";
        if (change === "inactive") h.record.active = false;
        return response([h.current]);
      });
      await expect(h.registry.assertPurchasable(h.service.id, h.evidence)).rejects.toMatchObject({
        code: change === "revision" || change === "price" ? "SERVICE_BINDING_CHANGED" : "SERVICE_VERIFICATION_REQUIRED",
      });
      expect(h.fetcher).toHaveBeenCalledTimes(1);
      expect(h.findUnique).toHaveBeenCalledTimes(2);
      expect(h.findMany).not.toHaveBeenCalled();
    },
  );

  it.each(["empty", "unavailable"] as const)("fails closed on %s results without endpoint-only retry or local fallback", async (mode) => {
    const h = fixture();
    h.fetcher.mockResolvedValue(mode === "empty" ? response([]) : Response.json({}, { status: 503 }));
    await expect(h.registry.assertPurchasable(h.service.id, h.evidence)).rejects.toMatchObject({
      code: mode === "empty" ? "BAZAAR_SERVICE_NOT_FOUND" : "BAZAAR_UNAVAILABLE",
    });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(h.findUnique).toHaveBeenCalledTimes(1);
    expect(h.findMany).not.toHaveBeenCalled();
  });

  it("retains the explicit local-demo evidence path without querying Bazaar", async () => {
    const h = fixture();
    await expect(h.registry.assertPurchasable(h.service.id, { ...h.evidence, source: "local_registry" })).resolves.toBeUndefined();
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.findUnique).toHaveBeenCalledTimes(1);
    expect(h.findMany).not.toHaveBeenCalled();
  });
});
