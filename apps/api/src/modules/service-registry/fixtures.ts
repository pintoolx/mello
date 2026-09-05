// Synthetic public identities used only by unit/integration tests. No fetches to
// these seller domains and no automatic approval of production seed data.
import { BASE_SEPOLIA_USDC, MELLO_NETWORK, type ServiceRecord } from "@mello/shared";
import { type BazaarResource, type BazaarResult } from "./bazaar-client.js";
import { serviceBindingHash, type VerificationRecord } from "./verification.js";

export const reviewNow = new Date("2026-09-05T12:00:00Z");
export const registryFixture: ServiceRecord = {
  id: "svc-seller-b-credit-report", sellerId: "seller-b", sellerLegalName: "Mello Seller B",
  sellerBusinessId: "24536806", payToAddress: "0x3333333333333333333333333333333333333333",
  invoiceCapability: "TW_B2B_DEMO", invoiceProvider: "MOCK", category: "credit_report",
  endpoint: "https://seller-b.example.com/v1/credit-report", method: "POST",
  priceAtomic: "50000", tokenSymbol: "USDC", tokenAddress: BASE_SEPOLIA_USDC,
  tokenDecimals: 6, network: MELLO_NETWORK, supportsTwInvoice: true, active: true,
};
export function resourceFixture(service = registryFixture): BazaarResource {
  return { resource: service.endpoint, type: "http", x402Version: 2,
    accepts: [{ scheme: "exact", network: service.network, amount: service.priceAtomic, payTo: service.payToAddress, asset: service.tokenAddress }],
    extensions: { bazaar: { info: { input: { type: "http", method: service.method } } } },
  };
}
export function reviewFixture(service = registryFixture): VerificationRecord {
  return { revision: 1, status: "VERIFIED", bindingHash: serviceBindingHash(service),
    scopes: ["ENDPOINT_CONTROL", "PAYMENT_WALLET_CONTROL", "DEMO_INVOICE_INTEGRATION"],
    reviewedAt: new Date("2026-09-05T00:00:00Z"), expiresAt: new Date("2026-09-06T00:00:00Z"), revokedAt: null,
  };
}
export function resultFixture(resources = [resourceFixture()]): BazaarResult {
  return { source: "cdp_bazaar", fetchedAt: reviewNow.toISOString(), partialResults: false, rejectedResourceCount: 0, resources };
}
