import { describe, expect, it, vi } from "vitest";
import { MARKET_SERVICE_CATALOG, SERVICE_CATEGORIES, type ServiceRecord } from "@mello/shared";
import { BazaarResourceSchema } from "./bazaar-client.js";
import { matchingBazaarResource, normalizeRegistryService, ServiceRegistry } from "./registry-service.js";
import { registryFixture, resourceFixture, resultFixture } from "./fixtures.js";
import { createRouteExtensions } from "../../seller-kit/protocol.js";

const product = MARKET_SERVICE_CATALOG[2];
const service: ServiceRecord = { ...registryFixture, id: product.id, category: product.category };
function branch(id = service.id, category = service.category) {
  return { type: "object", properties: { serviceId: { type: "string", const: id }, serviceCategory: { type: "string", const: category },
    serviceQuery: { type: "string", minLength: 1, maxLength: 200 } }, required: ["serviceId", "serviceCategory", "serviceQuery"], additionalProperties: false };
}
function advertised(alternatives: unknown[] = [branch()]) {
  const resource = resourceFixture(service);
  resource.extensions.bazaar.schema = { properties: { input: { properties: { body: { oneOf: alternatives } } } } };
  return resource;
}

describe("service category discovery boundaries", () => {
  it("requires modern advertised service ID/category together; an old credit quote is not a market product", () => {
    expect(matchingBazaarResource(service, resourceFixture(service))).toBe(false);
    expect(matchingBazaarResource(service, BazaarResourceSchema.parse(advertised()))).toBe(true);
    expect(matchingBazaarResource(service, advertised([branch(service.id, "stock_analysis"), branch("different-id", service.category)]))).toBe(false);
    expect(matchingBazaarResource(service, advertised([{ ...branch(), required: ["serviceId", "serviceCategory"] }]))).toBe(false);
    expect(matchingBazaarResource(service, resourceFixture())).toBe(false);
    expect(matchingBazaarResource(registryFixture, resourceFixture())).toBe(true);
  });

  it("accepts the actual seller-kit discovery schema for both products hosted at the same endpoint", () => {
    const extensions = createRouteExtensions({ sellerId: "seller-b", sellerName: "mello資本", port: 0,
      publicUrl: "https://seller-b.example.com", bazaarEnabled: true, paymentMode: "mock", facilitatorUrl: "https://x402.org/facilitator",
      network: service.network, tokenAddress: service.tokenAddress, tokenDecimals: 6, payToAddress: service.payToAddress,
      priceAtomic: service.priceAtomic, invoiceCapability: "TW_B2B_DEMO", purchaseContextHmacSecret: "test-only-schema-secret-at-least-32" });
    const resource = resourceFixture(service);
    resource.extensions.bazaar.schema = (extensions["bazaar"] as { schema: unknown }).schema;
    const parsed = BazaarResourceSchema.parse(resource);
    expect(matchingBazaarResource(service, parsed)).toBe(true);
    expect(matchingBazaarResource({ ...service, id: "macro-analysis", category: "macro_analysis" }, parsed)).toBe(true);
    expect(matchingBazaarResource({ ...service, id: "stock-analysis", category: "stock_analysis" }, parsed)).toBe(false);
  });

  it("keeps the category-aware query public and filters registry rows before comparing offers", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const search = vi.fn().mockResolvedValue(resultFixture([]));
    const registry = new ServiceRegistry({ service: { findMany } } as never, { search });
    await registry.discover(false, "crypto_market");
    expect(search).toHaveBeenCalledExactlyOnceWith({ query: "crypto market information" });
    expect(findMany).toHaveBeenCalledExactlyOnceWith({ where: { category: "crypto_market" }, orderBy: { id: "asc" }, include: { seller: true, verification: true } });
    await registry.discoverLocal(false, "stock_analysis");
    expect(findMany.mock.calls[1]?.[0].where.category).toBe("stock_analysis");
    expect(search).toHaveBeenCalledTimes(1);
    await registry.list();
    expect(findMany.mock.calls[2]?.[0].where.category).toEqual({ in: [...SERVICE_CATEGORIES] });
  });

  it("projects branding only when service ID, seller and category all agree", () => {
    const raw = { ...service, seller: { legalName: "Historical legal name", businessId: "24536806", payToAddress: service.payToAddress,
      invoiceCapability: "TW_B2B_DEMO", invoiceProvider: "MOCK", status: "ACTIVE" } };
    expect(normalizeRegistryService(raw)).toMatchObject({ displayName: "加密市場資訊", sellerDisplayName: "mello資本", sellerLegalName: "Historical legal name" });
    expect(normalizeRegistryService({ ...raw, category: "stock_analysis" })).not.toHaveProperty("sellerDisplayName");
    expect(normalizeRegistryService({ ...raw, sellerId: "seller-a" })).not.toHaveProperty("sellerDisplayName");
  });

  it("lists only the four current products while preserving archived rows for discovery diagnostics", async () => {
    const seller = { legalName: "Historical legal name", businessId: "24536806", payToAddress: service.payToAddress,
      invoiceCapability: "TW_B2B_DEMO", invoiceProvider: "MOCK", status: "ACTIVE" };
    const modern = MARKET_SERVICE_CATALOG.map((product) => ({ ...registryFixture, id: product.id,
      category: product.category, sellerId: product.sellerId, seller, verification: null }));
    const archived = ["a", "b", "c", "d"].map((suffix) => ({ ...registryFixture,
      id: `credit-report-${suffix}`, active: false, seller, verification: null }));
    const records = [...modern, ...archived];
    const findMany = vi.fn().mockResolvedValue(records);
    const registry = new ServiceRegistry({ service: { findMany } } as never, { search: vi.fn() });
    expect((await registry.list()).map((item) => item.id)).toEqual(MARKET_SERVICE_CATALOG.map((item) => item.id));
    expect(await registry.records()).toHaveLength(8);
    const diagnostic = await registry.discoverLocal(false);
    expect(diagnostic.services).toHaveLength(8);
    expect(diagnostic.assessments.filter((item) => item.reasonCodes.includes("SERVICE_INACTIVE"))).toHaveLength(4);
    expect(records.filter((item) => !item.active)).toHaveLength(4);

    findMany.mockResolvedValue(modern.map((item) => ({ ...item, seller: { ...seller, status: "SUSPENDED" } })));
    expect(await registry.list()).toEqual([]);
  });
});
