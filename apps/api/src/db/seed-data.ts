import {
  BASE_SEPOLIA_USDC,
  DEFAULT_ALLOWED_TOKEN,
  DEMO_COMPANY,
  DEMO_POLICY_ID,
  MELLO_NETWORK,
} from "@mello/shared";

const sellerAUrl = process.env["SELLER_A_URL"] ?? "http://localhost:4011";
const sellerBUrl = process.env["SELLER_B_URL"] ?? "http://localhost:4012";

export const seedCompany = DEMO_COMPANY;

export const seedPolicy = {
  id: DEMO_POLICY_ID,
  version: 1,
  perTxLimitAtomic: "100000",
  dailyLimitAtomic: "1000000",
  requireTwInvoice: true,
  allowedNetworks: [MELLO_NETWORK],
  allowedTokens: [DEFAULT_ALLOWED_TOKEN],
  allowedSellerIds: ["seller-a", "seller-b"],
  active: true,
} as const;

export const seedSellers = [
  {
    id: "seller-a",
    legalName: "Mello Data Labs A (Demo)",
    businessId: null,
    payToAddress: process.env["SELLER_A_PAY_TO"] ?? "0x1111111111111111111111111111111111111111",
    invoiceCapability: "NONE" as const,
    invoiceProvider: "NONE" as const,
    status: "ACTIVE" as const,
  },
  {
    id: "seller-b",
    legalName: "Mello Data Labs B (Demo)",
    businessId: "24536806",
    payToAddress: process.env["SELLER_B_PAY_TO"] ?? "0x2222222222222222222222222222222222222222",
    invoiceCapability: "TW_B2B_DEMO" as const,
    invoiceProvider: "MOCK" as const,
    status: "ACTIVE" as const,
  },
] as const;

export const seedServices = [
  {
    id: "credit-report-a",
    sellerId: "seller-a",
    category: "credit_report",
    endpoint: `${sellerAUrl}/v1/credit-report`,
    method: "POST",
    priceAtomic: "40000",
    tokenSymbol: "USDC",
    tokenAddress: process.env["USDC_TOKEN_ADDRESS"] ?? BASE_SEPOLIA_USDC,
    tokenDecimals: 6,
    network: MELLO_NETWORK,
    supportsTwInvoice: false,
    active: true,
  },
  {
    id: "credit-report-b",
    sellerId: "seller-b",
    category: "credit_report",
    endpoint: `${sellerBUrl}/v1/credit-report`,
    method: "POST",
    priceAtomic: "50000",
    tokenSymbol: "USDC",
    tokenAddress: process.env["USDC_TOKEN_ADDRESS"] ?? BASE_SEPOLIA_USDC,
    tokenDecimals: 6,
    network: MELLO_NETWORK,
    supportsTwInvoice: true,
    active: true,
  },
] as const;
