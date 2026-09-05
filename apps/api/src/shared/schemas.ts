import { z } from "zod";
import {
  BASE_SEPOLIA_USDC,
  MELLO_NETWORK,
  SELLER_IDS,
  USDC_DECIMALS,
  USDC_SYMBOL,
} from "./constants.js";
import { isValidTaiwanBusinessId } from "./business-id.js";
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
  email: z.email(),
  defaultCostCenter: z.string().trim().min(1).max(64),
});
export type CompanyProfileInput = z.infer<typeof CompanyProfileInputSchema>;

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
  serviceCategory: z.literal("credit_report"),
  targetCompanyName: z.string().trim().min(1),
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
});
export type PurchaseIntent = z.infer<typeof PurchaseIntentSchema>;

export const ServiceRecordSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().trim().min(1).max(100).nullable().optional(),
  sellerId: z.enum(SELLER_IDS),
  sellerLegalName: z.string().min(1),
  sellerBusinessId: z.string().nullable(),
  payToAddress: EvmAddressSchema,
  invoiceCapability: z.enum(["NONE", "TW_B2B_DEMO"]),
  invoiceProvider: z.enum(["NONE", "MOCK", "ECPAY_STAGE"]),
  category: z.literal("credit_report"),
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
