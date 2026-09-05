import { describe, expect, it } from "vitest";
import { assessDiscovery, matchingBazaarResource } from "./registry-service.js";
import { isPublicServiceEndpoint, serviceBindingHash, verificationSummary } from "./verification.js";
import { registryFixture as service, resourceFixture, resultFixture, reviewFixture, reviewNow } from "./fixtures.js";

describe("Mello service attestation is independent from Bazaar and policy", () => {
  it("requires a Bazaar match AND a current scoped review", () => {
    expect(assessDiscovery(service, reviewFixture(), resultFixture(), reviewNow).evidence).toMatchObject({ source: "cdp_bazaar", verificationRevision: 1 });
    expect(assessDiscovery(service, null, resultFixture(), reviewNow)).toMatchObject({ evidence: null, reasonCodes: ["VERIFICATION_UNREVIEWED"] });
    expect(assessDiscovery(service, reviewFixture(), resultFixture([]), reviewNow).evidence).toBeNull();
  });
  it.each([
    ["REVOKED", { status: "REVOKED" }],
    ["REVOKED", { revokedAt: reviewNow }],
    ["EXPIRED", { expiresAt: reviewNow }],
    ["EXPIRED", { reviewedAt: new Date("2027-01-01") }],
    ["UNREVIEWED", { status: "ACTIVE" }],
    ["BINDING_CHANGED", { bindingHash: `0x${"00".repeat(32)}` }],
    ["SCOPE_INCOMPLETE", { scopes: ["ENDPOINT_CONTROL", "PAYMENT_WALLET_CONTROL"] }],
  ] as const)("rejects %s reviews", (status, change) => {
    expect(verificationSummary(service, { ...reviewFixture(), ...change }, reviewNow).status).toBe(status);
  });
  it.each([
    { endpoint: "https://other.example.com/v1/credit-report" },
    { sellerLegalName: "Changed business" }, { sellerBusinessId: "12345675" },
    { payToAddress: "0x4444444444444444444444444444444444444444" },
    { supportsTwInvoice: false },
  ])("invalidates changed certified identity %j", (change) => {
    expect(serviceBindingHash({ ...service, ...change })).not.toBe(serviceBindingHash(service));
  });
  it("does not invalidate identity solely for price changes; live quote matching still rejects them", () => {
    const changed = { ...service, priceAtomic: "60000" };
    expect(serviceBindingHash(changed)).toBe(serviceBindingHash(service));
    expect(matchingBazaarResource(changed, resourceFixture())).toBe(false);
  });
  it.each(["scheme", "network", "amount", "payTo", "asset"] as const)("never accepts a substituted %s", (key) => {
    const resource = resourceFixture();
    resource.accepts[0]![key] = key === "amount" ? "40000" : "wrong";
    expect(matchingBazaarResource(service, resource)).toBe(false);
  });
  it("uses exact URL and method, not name, payTo alone, prefix or substring", () => {
    const resource = resourceFixture();
    resource.resource += "/evil";
    expect(matchingBazaarResource(service, resource)).toBe(false);
    resource.resource = service.endpoint;
    resource.extensions.bazaar.info.input.method = "GET";
    expect(matchingBazaarResource(service, resource)).toBe(false);
  });
  it.each([
    "http://seller.example.com/api", "https://localhost/api", "https://127.0.0.1/api",
    "https://[::1]/api", "https://2130706433/api", "https://seller.railway.internal/api",
    "https://seller.example.com/api?token=secret", "https://u:p@seller.example.com/api",
    "https://seller.example.com/api#fragment", "https://seller.example.com:9443/api",
    "https://seller.example.com./api", "https://seller.example.com/../api",
  ])("rejects unsafe/unreviewable endpoint %s", (endpoint) => {
    expect(isPublicServiceEndpoint(endpoint)).toBe(false);
  });
});
