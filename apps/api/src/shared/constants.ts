export const MELLO_NETWORK = "eip155:84532" as const;
export const MELLO_CHAIN_ID = 84_532;
export const USDC_SYMBOL = "USDC" as const;
export const USDC_DECIMALS = 6;
export const BASE_SEPOLIA_USDC =
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

export const SELLER_IDS = ["seller-a", "seller-b"] as const;
export type SellerId = (typeof SELLER_IDS)[number];

export const DEMO_COMPANY_ID = "00000000-0000-4000-8000-000000000001";
export const DEMO_POLICY_ID = "00000000-0000-4000-8000-000000000002";

export const DEMO_COMPANY = {
  id: DEMO_COMPANY_ID,
  legalName: "Mello Demo Corp.",
  businessId: "12345675",
  email: "finance@example.test",
  defaultCostCenter: "RISK-DATA",
} as const;

export const DEMO_PROMPTS = {
  happy: "幫我買一份 Example Co. 的信用報告，預算 0.1 USDC，要開統編發票。",
  rejected: "幫我買一份 Example Co. 的信用報告，預算 0.03 USDC，要開統編發票。",
  noInvoice: "幫我買一份 Example Co. 的信用報告，預算 0.1 USDC，不需要發票。",
} as const;
