import type { ResourceServerExtension } from "@x402/core/types";
import { z } from "zod";

export const TW_EINVOICE_EXTENSION_KEY = "tw-einvoice" as const;

export const TwEinvoiceDeclarationSchema = z
  .object({
    version: z.literal("0.1"),
    jurisdiction: z.literal("TW"),
    mode: z.literal("B2B_DEMO"),
    sellerProfileId: z.string().trim().min(1),
    provider: z.literal("mock"),
    priceIncludesTax: z.boolean(),
    requiredContext: z.tuple([z.literal("purchaseContextToken")]),
    supports: z
      .object({
        void: z.literal(false),
        allowance: z.literal(false),
        aggregation: z.literal(false),
      })
      .strict(),
  })
  .strict();

export type TwEinvoiceDeclaration = z.infer<typeof TwEinvoiceDeclarationSchema>;

export const TwEinvoiceSettlementMetadataSchema = z
  .object({
    accepted: z.literal(true),
    sellerProfileId: z.string().trim().min(1),
    invoiceMode: z.literal("B2B_DEMO"),
    invoiceStatus: z.literal("READY_FOR_ORCHESTRATION"),
  })
  .strict();

export type TwEinvoiceSettlementMetadata = z.infer<
  typeof TwEinvoiceSettlementMetadataSchema
>;

export function declareTwEinvoiceExtension(
  sellerProfileId: string,
): TwEinvoiceDeclaration {
  return TwEinvoiceDeclarationSchema.parse({
    version: "0.1",
    jurisdiction: "TW",
    mode: "B2B_DEMO",
    sellerProfileId,
    provider: "mock",
    priceIncludesTax: true,
    requiredContext: ["purchaseContextToken"],
    supports: {
      void: false,
      allowance: false,
      aggregation: false,
    },
  });
}

export function createTwEinvoiceSettlementMetadata(
  sellerProfileId: string,
): TwEinvoiceSettlementMetadata {
  return TwEinvoiceSettlementMetadataSchema.parse({
    accepted: true,
    sellerProfileId,
    invoiceMode: "B2B_DEMO",
    invoiceStatus: "READY_FOR_ORCHESTRATION",
  });
}

/**
 * x402 resource-server extension for Mello's demo Taiwan B2B invoice signal.
 *
 * The declaration is intentionally free of buyer PII. The settlement enrichment
 * only states that the paid request is ready for Mello's internal invoice
 * orchestrator; it does not claim that a legal invoice has been issued.
 */
export const twEinvoiceResourceServerExtension: ResourceServerExtension = {
  key: TW_EINVOICE_EXTENSION_KEY,
  enrichDeclaration(declaration) {
    return TwEinvoiceDeclarationSchema.parse(declaration);
  },
  async enrichPaymentRequiredResponse(declaration) {
    return TwEinvoiceDeclarationSchema.parse(declaration);
  },
  async enrichSettlementResponse(declaration) {
    const parsed = TwEinvoiceDeclarationSchema.parse(declaration);
    return createTwEinvoiceSettlementMetadata(parsed.sellerProfileId);
  },
};
