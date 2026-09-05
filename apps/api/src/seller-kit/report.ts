import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  CreditReport,
  CreditReportRequest,
  PaymentMode,
} from "./types.js";

export const CreditReportRequestSchema = z
  .object({
    targetCompanyName: z.string().trim().min(1).max(200),
    purchaseContextToken: z.string().trim().min(16).max(4_096),
  })
  .strict();

export const PublicCreditReportRequestSchema = CreditReportRequestSchema.extend({
  purchaseContextToken: CreditReportRequestSchema.shape.purchaseContextToken.optional(),
});

export const CreditReportSchema = z
  .object({
    reportId: z.string().regex(/^rpt_[a-f0-9]{20}$/),
    provider: z.string().min(1),
    targetCompanyName: z.string().min(1),
    riskScore: z.number().int().min(0).max(100),
    riskLevel: z.enum(["LOW", "MEDIUM", "HIGH"]),
    summary: z.literal("Demo credit report only"),
    generatedAt: z.iso.datetime(),
    paymentMode: z.enum(["mock", "x402"]),
    isDemo: z.literal(true),
  })
  .strict();

function riskLevel(score: number): CreditReport["riskLevel"] {
  if (score < 34) return "LOW";
  if (score < 80) return "MEDIUM";
  return "HIGH";
}

export function createDeterministicCreditReport(
  sellerId: string,
  input: CreditReportRequest,
  paymentMode: PaymentMode,
  generatedAt: Date,
): CreditReport {
  const digest = createHash("sha256")
    .update(`${sellerId}\u0000${input.targetCompanyName.trim().toLowerCase()}`)
    .digest("hex");
  const score = Number.parseInt(digest.slice(0, 8), 16) % 101;

  return CreditReportSchema.parse({
    reportId: `rpt_${digest.slice(0, 20)}`,
    provider: sellerId,
    targetCompanyName: input.targetCompanyName.trim(),
    riskScore: score,
    riskLevel: riskLevel(score),
    summary: "Demo credit report only",
    generatedAt: generatedAt.toISOString(),
    paymentMode,
    isDemo: true,
  });
}
