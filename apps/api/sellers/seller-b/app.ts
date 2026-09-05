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
import {
  createTwEinvoiceSettlementMetadata,
  declareTwEinvoiceExtension,
  TW_EINVOICE_EXTENSION_KEY,
  twEinvoiceResourceServerExtension,
} from "@mello/tw-einvoice-extension";

const DEFAULT_PAY_TO = "0x2222222222222222222222222222222222222222";
const DEFAULT_CONTEXT_HMAC_SECRET =
  "change-me-with-at-least-32-random-characters";

export function readSellerBConfig(
  env: NodeJS.ProcessEnv = process.env,
): SellerServerConfig {
  const port = readPort(env["SELLER_B_PORT"], 4_012);
  return {
    sellerId: "seller-b",
    sellerName: "Mello Seller B",
    port,
    bindHost: env["SELLER_BIND_HOST"] ?? "127.0.0.1",
    publicUrl: env["SELLER_B_URL"] ?? `http://localhost:${port}`,
    paymentMode: readPaymentMode(env["PAYMENT_MODE"]),
    facilitatorUrl:
      env["X402_FACILITATOR_URL"] ?? "https://x402.org/facilitator",
    network: readNetwork(env["X402_NETWORK"], MELLO_NETWORK),
    tokenAddress: env["USDC_TOKEN_ADDRESS"] ?? BASE_SEPOLIA_USDC,
    tokenDecimals: Number(env["USDC_TOKEN_DECIMALS"] ?? USDC_DECIMALS),
    payToAddress: env["SELLER_B_PAY_TO"] ?? DEFAULT_PAY_TO,
    priceAtomic: "50000",
    invoiceCapability: "TW_B2B_DEMO",
    purchaseContextHmacSecret:
      env["SELLER_CONTEXT_HMAC_SECRET"] ?? DEFAULT_CONTEXT_HMAC_SECRET,
    routeExtensions: {
      [TW_EINVOICE_EXTENSION_KEY]: declareTwEinvoiceExtension("seller-b"),
    },
    settlementExtensions: {
      [TW_EINVOICE_EXTENSION_KEY]:
        createTwEinvoiceSettlementMetadata("seller-b"),
    },
    resourceServerExtensions: [twEinvoiceResourceServerExtension],
  };
}

export function createSellerBApplication(
  overrides: Partial<SellerServerConfig> = {},
  options: SellerApplicationOptions = {},
): SellerApplication {
  return createSellerApplication(
    {
      ...readSellerBConfig({}),
      ...overrides,
    },
    options,
  );
}
