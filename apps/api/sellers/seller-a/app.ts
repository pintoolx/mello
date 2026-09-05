import {
  createSellerApplication,
  readNetwork,
  readPaymentMode,
  readPort,
  type SellerApplication,
  type SellerApplicationOptions,
  type SellerServerConfig,
} from "@mello/seller-kit";
import { BASE_SEPOLIA_USDC, MELLO_NETWORK, USDC_DECIMALS } from "@mello/shared";

const DEFAULT_PAY_TO = "0x1111111111111111111111111111111111111111";
const DEFAULT_CONTEXT_HMAC_SECRET =
  "change-me-with-at-least-32-random-characters";

export function readSellerAConfig(
  env: NodeJS.ProcessEnv = process.env,
): SellerServerConfig {
  const port = readPort(env["SELLER_A_PORT"], 4_011);
  return {
    sellerId: "seller-a",
    sellerName: "Mello Seller A",
    port,
    bindHost: env["SELLER_BIND_HOST"] ?? "127.0.0.1",
    publicUrl: env["SELLER_A_URL"] ?? `http://localhost:${port}`,
    paymentMode: readPaymentMode(env["PAYMENT_MODE"]),
    facilitatorUrl:
      env["X402_FACILITATOR_URL"] ?? "https://x402.org/facilitator",
    network: readNetwork(env["X402_NETWORK"], MELLO_NETWORK),
    tokenAddress: env["USDC_TOKEN_ADDRESS"] ?? BASE_SEPOLIA_USDC,
    tokenDecimals: Number(env["USDC_TOKEN_DECIMALS"] ?? USDC_DECIMALS),
    payToAddress: env["SELLER_A_PAY_TO"] ?? DEFAULT_PAY_TO,
    priceAtomic: "40000",
    invoiceCapability: "NONE",
    purchaseContextHmacSecret:
      env["SELLER_CONTEXT_HMAC_SECRET"] ?? DEFAULT_CONTEXT_HMAC_SECRET,
  };
}

export function createSellerAApplication(
  overrides: Partial<SellerServerConfig> = {},
  options: SellerApplicationOptions = {},
): SellerApplication {
  return createSellerApplication(
    {
      ...readSellerAConfig({}),
      ...overrides,
    },
    options,
  );
}
