import { z } from "zod";
import {
  BASE_SEPOLIA_USDC,
  MELLO_NETWORK,
  SELLER_IDS,
  USDC_DECIMALS,
  USDC_SYMBOL,
} from "./constants.js";
import { isValidTaiwanBusinessId } from "./business-id.js";
import { ServiceCategorySchema } from "./service-catalog.js";
import {
  AnchorStatusSchema,
  InvoiceStatusSchema,
  PaymentAuthorizationStatusSchema,
  PaymentStatusSchema,
  ReconciliationStatusSchema,
  TaskStatusSchema,
} from "./enums.js";

export const AtomicAmountSchema = z.string().regex(/^\d+$/, "Must be an atomic-unit integer string");
export const EvmAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Must be an EVM address");
export const Bytes32Schema = z.string().regex(/^0x[a-fA-F0-9]{64}$/, "Must be bytes32 hex");

export const CompanyProfileInputSchema = z.object({
  legalName: z.string().trim().min(1).max(100),
  businessId: z
    .string()
    .regex(/^\d{8}$/, "Business ID must contain exactly 8 digits")
    .refine(isValidTaiwanBusinessId, "Business ID checksum is invalid"),
  email: z.email().max(254),
  defaultCostCenter: z.string().trim().min(1).max(64),
  contactName: z.string().trim().max(100).optional(),
  phone: z.string().trim().max(32).optional(),
  address: z.string().trim().max(255).optional(),
  invoiceEmail: z.union([z.email().max(254), z.literal("")]).optional(),
  invoiceAddress: z.string().trim().max(255).optional(),
});
export type CompanyProfileInput = z.infer<typeof CompanyProfileInputSchema>;

export const InvoiceBuyerProfileSchema = z.object({
  legalName: z.string(),
  businessId: z.string(),
  email: z.string(),
  address: z.string(),
  contactName: z.string(),
  phone: z.string(),
});
export type InvoiceBuyerProfile = z.infer<typeof InvoiceBuyerProfileSchema>;

export function invoiceBuyerProfile(company: CompanyProfileInput): InvoiceBuyerProfile {
  return {
    legalName: company.legalName,
    businessId: company.businessId,
    email: company.invoiceEmail || company.email,
    address: company.invoiceAddress || company.address || "",
    contactName: company.contactName || "",
    phone: company.phone || "",
  };
}

export const AllowedTokenSchema = z.object({
  symbol: z.literal(USDC_SYMBOL),
  address: EvmAddressSchema,
  decimals: z.literal(USDC_DECIMALS),
});

export const PolicyInputSchema = z.object({
  perTxLimitAtomic: AtomicAmountSchema,
  dailyLimitAtomic: AtomicAmountSchema,
  requireTwInvoice: z.boolean(),
  allowedNetworks: z.array(z.literal(MELLO_NETWORK)).min(1),
  allowedTokens: z.array(AllowedTokenSchema).min(1),
  allowedSellerIds: z.array(z.enum(SELLER_IDS)).min(1),
});
export type PolicyInput = z.infer<typeof PolicyInputSchema>;

export const PurchaseIntentSchema = z.object({
  serviceCategory: ServiceCategorySchema,
  serviceQuery: z.string().trim().min(1).max(200).optional(),
  targetCompanyName: z.string().trim().min(1).optional(),
  maxAmount: z.object({
    atomic: AtomicAmountSchema,
    display: z.string().min(1),
    token: z.literal(USDC_SYMBOL),
  }),
  requiresTwInvoice: z.boolean(),
  buyerBusinessId: z.string().regex(/^\d{8}$/),
  costCenter: z.string().trim().min(1),
  networkPreference: z.literal(MELLO_NETWORK),
  usedDemoDefaultTarget: z.boolean().default(false),
}).superRefine((intent, context) => {
  if (intent.serviceCategory === "credit_report") {
    if (!intent.targetCompanyName) context.addIssue({ code: "custom", path: ["targetCompanyName"], message: "信用報告需要明確的企業徵信標的。" });
    if (intent.serviceQuery !== undefined) context.addIssue({ code: "custom", path: ["serviceQuery"], message: "信用報告使用 targetCompanyName，不應填入分析服務需求。" });
  } else {
    if (!intent.serviceQuery) context.addIssue({ code: "custom", path: ["serviceQuery"], message: "分析服務需要明確的服務需求。" });
    if (intent.targetCompanyName !== undefined) context.addIssue({ code: "custom", path: ["targetCompanyName"], message: "分析服務使用 serviceQuery，不應填入企業徵信標的。" });
    if (intent.usedDemoDefaultTarget) context.addIssue({ code: "custom", path: ["usedDemoDefaultTarget"], message: "分析服務不得使用預設企業標的。" });
  }
});
export type PurchaseIntent = z.infer<typeof PurchaseIntentSchema>;

export const ServiceRecordSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().trim().min(1).max(100).nullable().optional(),
  sellerId: z.enum(SELLER_IDS),
  sellerLegalName: z.string().min(1),
  sellerDisplayName: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().min(1).max(1000).optional(),
  sellerBusinessId: z.string().nullable(),
  payToAddress: EvmAddressSchema,
  invoiceCapability: z.enum(["NONE", "TW_B2B_DEMO"]),
  invoiceProvider: z.enum(["NONE", "MOCK", "ECPAY_STAGE"]),
  category: ServiceCategorySchema,
  endpoint: z.url(),
  method: z.literal("POST"),
  priceAtomic: AtomicAmountSchema,
  tokenSymbol: z.literal(USDC_SYMBOL),
  tokenAddress: EvmAddressSchema,
  tokenDecimals: z.literal(USDC_DECIMALS),
  network: z.literal(MELLO_NETWORK),
  supportsTwInvoice: z.boolean(),
  active: z.boolean(),
});
export type ServiceRecord = z.infer<typeof ServiceRecordSchema>;

export const CandidateEvaluationSchema = z.object({
  serviceId: z.string(),
  displayName: z.string().trim().min(1).max(100).nullable().optional(),
  sellerId: z.enum(SELLER_IDS),
  sellerLegalName: z.string().min(1),
  sellerDisplayName: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().min(1).max(1000).optional(),
  category: ServiceCategorySchema.optional(),
  invoiceCapability: z.enum(["NONE", "TW_B2B_DEMO"]),
  supportsTwInvoice: z.boolean(),
  priceAtomic: AtomicAmountSchema,
  eligible: z.boolean(),
  reasonCodes: z.array(z.string()),
  humanSummary: z.string(),
});
export type CandidateEvaluation = z.infer<typeof CandidateEvaluationSchema>;

export const PolicyDecisionSchema = z.object({
  approved: z.boolean(),
  reasonCodes: z.array(z.string()),
  policyVersion: z.number().int().positive(),
  evaluatedAt: z.iso.datetime(),
  expectedAmountAtomic: AtomicAmountSchema,
  dailySpendBeforeAtomic: AtomicAmountSchema,
  dailySpendAfterAtomic: AtomicAmountSchema,
});
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const TaskRequirementsSchema = z.object({
  requiresTwInvoice: z.boolean(),
  requiresRegistryCertification: z.boolean(),
}).strict();
export type TaskRequirements = z.infer<typeof TaskRequirementsSchema>;

export const ServiceSelectionSchema = z.object({
  serviceId: z.string().min(1).max(64),
  selectionHash: Bytes32Schema,
}).strict();
export type ServiceSelection = z.infer<typeof ServiceSelectionSchema>;

export const CreateTaskSchema = z.object({
  prompt: z.string().trim().min(3).max(2_000),
  requestKey: z.string().regex(/^[a-zA-Z0-9_-]{16,128}$/).optional(),
  approvalLimitAtomic: AtomicAmountSchema.max(78).optional(),
  expectedPayTo: EvmAddressSchema.optional(),
  requirements: TaskRequirementsSchema.optional(),
  attachmentIds: z.array(z.uuid()).max(3).refine((ids) => new Set(ids).size === ids.length, "附件不能重複").optional(),
}).superRefine((input, context) => {
  if (input.attachmentIds?.length) {
    if (!input.requestKey) context.addIssue({ code: "custom", path: ["requestKey"], message: "附件必須綁定申請編號。" });
    if (!input.requirements) context.addIssue({ code: "custom", path: ["requirements"], message: "附件只適用於需確認選用服務的申請。" });
  }
});

export const Erc3009AuthorizationRecordSchema = z.object({
  purchaseId: z.uuid(),
  paymentId: z.string().min(16).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  tokenAddress: EvmAddressSchema,
  from: EvmAddressSchema,
  to: EvmAddressSchema,
  value: AtomicAmountSchema,
  validAfter: z.bigint(),
  validBefore: z.bigint(),
  nonce: Bytes32Schema,
  eip712Domain: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    chainId: z.literal(84532),
    verifyingContract: EvmAddressSchema,
  }),
  typedDataHash: Bytes32Schema,
  signatureHash: Bytes32Schema.optional(),
  settlementTxHash: Bytes32Schema.optional(),
  status: PaymentAuthorizationStatusSchema,
});
export type Erc3009AuthorizationRecord = z.infer<
  typeof Erc3009AuthorizationRecordSchema
>;

export const RuntimeModesSchema = z.object({
  agent: z.enum(["openai", "demo"]),
  payment: z.enum(["x402", "mock"]),
  invoice: z.enum(["mock", "ecpay_stage"]),
  anchor: z.enum(["onchain", "mock", "disabled"]),
});

export const PurchaseSummaryStatusSchema = z.object({
  task: TaskStatusSchema,
  payment: PaymentStatusSchema,
  invoice: InvoiceStatusSchema,
  reconciliation: ReconciliationStatusSchema,
  authorizationAnchor: AnchorStatusSchema,
  finalizationAnchor: AnchorStatusSchema,
});

export const DEFAULT_ALLOWED_TOKEN = {
  symbol: USDC_SYMBOL,
  address: BASE_SEPOLIA_USDC,
  decimals: USDC_DECIMALS,
} as const;
