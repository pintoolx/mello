import { describe, expect, it } from "vitest";
import { surveyCandidate } from "./survey.js";
import { registryFixture as service } from "../service-registry/fixtures.js";

describe("survey requirement and selection boundaries", () => {
  const candidate = { serviceId: service.id, sellerId: service.sellerId, sellerLegalName: service.sellerLegalName,
    invoiceCapability: service.invoiceCapability, supportsTwInvoice: true, priceAtomic: service.priceAtomic,
    eligible: true, reasonCodes: ["CANDIDATE_ELIGIBLE"], humanSummary: "eligible" };

  it.each([true, false])("keeps invoice and certification independent (invoice required: %s)", (requiresTwInvoice) => {
    for (const requiresRegistryCertification of [true, false]) for (const supportsTwInvoice of [true, false]) for (const certified of [true, false]) {
      const result = surveyCandidate(candidate, { ...service, supportsTwInvoice, invoiceCapability: supportsTwInvoice ? "TW_B2B_DEMO" : "NONE" },
        { requiresTwInvoice, requiresRegistryCertification }, { status: certified ? "VERIFIED" : "UNREVIEWED", revision: certified ? 1 : null });
      expect(result.matchesRequirements).toBe((!requiresTwInvoice || supportsTwInvoice) && (!requiresRegistryCertification || certified));
      expect(result.eligible).toBe(result.matchesRequirements);
    }
  });

  it("keeps non-required services visible while explaining enterprise restrictions", () => {
    const result = surveyCandidate({ ...candidate, eligible: false, reasonCodes: ["INVOICE_UNSUPPORTED"] }, service,
      { requiresTwInvoice: false, requiresRegistryCertification: false }, { status: "UNREVIEWED", revision: null });
    expect(result).toMatchObject({ matchesRequirements: true, eligible: false, reasonCodes: ["INVOICE_UNSUPPORTED"] });
  });

  it("binds human selection to the exact service, quote, and required review revision", () => {
    const requirements = { requiresTwInvoice: true, requiresRegistryCertification: true };
    const review = { status: "VERIFIED", revision: 1 };
    const initial = surveyCandidate(candidate, service, requirements, review);
    for (const changed of [{ ...service, priceAtomic: "60000" }, { ...service, endpoint: "https://other.example.com/report" }, { ...service, id: "another" }]) {
      expect(surveyCandidate(candidate, changed, requirements, review).selectionHash).not.toBe(initial.selectionHash);
    }
    expect(surveyCandidate(candidate, service, requirements, { ...review, revision: 2 }).selectionHash).not.toBe(initial.selectionHash);
  });
});
