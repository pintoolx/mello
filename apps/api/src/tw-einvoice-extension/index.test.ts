import { describe, expect, it } from "vitest";
import {
  createTwEinvoiceSettlementMetadata,
  declareTwEinvoiceExtension,
  TW_EINVOICE_EXTENSION_KEY,
  TwEinvoiceDeclarationSchema,
} from "./index.js";

describe("tw-einvoice extension", () => {
  it("declares the P0 v0.1 B2B demo capability without buyer PII", () => {
    const declaration = declareTwEinvoiceExtension("seller-b");

    expect(TW_EINVOICE_EXTENSION_KEY).toBe("tw-einvoice");
    expect(declaration).toEqual({
      version: "0.1",
      jurisdiction: "TW",
      mode: "B2B_DEMO",
      sellerProfileId: "seller-b",
      provider: "mock",
      priceIncludesTax: true,
      requiredContext: ["purchaseContextToken"],
      supports: {
        void: false,
        allowance: false,
        aggregation: false,
      },
    });
    expect(JSON.stringify(declaration)).not.toMatch(
      /businessId|legalName|email/i,
    );
  });

  it("rejects undeclared fields and emits orchestration-only settlement metadata", () => {
    expect(() =>
      TwEinvoiceDeclarationSchema.parse({
        ...declareTwEinvoiceExtension("seller-b"),
        buyerBusinessId: "12345675",
      }),
    ).toThrow();

    expect(createTwEinvoiceSettlementMetadata("seller-b")).toEqual({
      accepted: true,
      sellerProfileId: "seller-b",
      invoiceMode: "B2B_DEMO",
      invoiceStatus: "READY_FOR_ORCHESTRATION",
    });
  });
});
