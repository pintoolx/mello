import {
  BASE_SEPOLIA_USDC,
  EvmAddressSchema,
  MELLO_NETWORK,
  USDC_DECIMALS,
} from "@mello/shared";
import { z } from "zod";

const blankToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const OptionalHexSchema = z.preprocess(
  blankToUndefined,
  z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
);
const OptionalAddressSchema = z.preprocess(blankToUndefined, EvmAddressSchema.optional());
const UNSAFE_CONTEXT_HMAC_SECRET =
  "change-me-with-at-least-32-random-characters";

const EnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    CORE_API_HOST: z.string().trim().min(1).default("127.0.0.1"),
    CORE_API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
    DATABASE_URL: z.string().min(1),
    DEMO_ADMIN_TOKEN: z.string().min(8).default("change-me-before-public-deploy"),
    API_ACCESS_TOKEN: z.preprocess(blankToUndefined, z.string().min(32).optional()),
    AGENT_MODE: z.enum(["openai", "demo"]).default("demo"),
    SERVICE_DISCOVERY_MODE: z.enum(["local_demo", "bazaar"]).default("local_demo"),
    BAZAAR_TIMEOUT_MS: z.coerce.number().int().min(100).max(15_000).default(5_000),
    OPENAI_API_KEY: z.preprocess(blankToUndefined, z.string().min(1).optional()),
    OPENAI_MODEL: z.preprocess(blankToUndefined, z.string().min(1).optional()),
    PAYMENT_MODE: z.enum(["x402", "mock"]).default("mock"),
    X402_FACILITATOR_URL: z.string().url().default("https://x402.org/facilitator"),
    X402_NETWORK: z.literal(MELLO_NETWORK).default(MELLO_NETWORK),
    USDC_TOKEN_ADDRESS: EvmAddressSchema.default(BASE_SEPOLIA_USDC),
    USDC_TOKEN_DECIMALS: z.coerce.number().int().default(6),
    EVM_PRIVATE_KEY: OptionalHexSchema,
    SELLER_A_PAY_TO: EvmAddressSchema.default(
      "0x1111111111111111111111111111111111111111",
    ),
    SELLER_B_PAY_TO: EvmAddressSchema.default(
      "0x2222222222222222222222222222222222222222",
    ),
    SELLER_A_URL: z.string().url().default("http://localhost:4011"),
    SELLER_B_URL: z.string().url().default("http://localhost:4012"),
    SELLER_CONTEXT_HMAC_SECRET: z
      .string()
      .min(32)
      .default("change-me-with-at-least-32-random-characters"),
    BASE_SEPOLIA_RPC_URL: z.string().url().default("https://sepolia.base.org"),
    BASESCAN_BASE_URL: z.string().url().default("https://sepolia.basescan.org"),
    CONTRACT_ANCHOR_MODE: z.enum(["onchain", "mock", "disabled"]).default("mock"),
    CONTRACT_OPERATOR_PRIVATE_KEY: OptionalHexSchema,
    AUDIT_REGISTRY_ADDRESS: OptionalAddressSchema,
    DEMO_ALLOW_OFFCHAIN_AUTH: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    ERC3009_RECORDING_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    ERC3009_AUTH_TTL_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),
    ERC8004_IDENTITY_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    ERC8004_REPUTATION_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    ERC8196_WALLET_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    INVOICE_PROVIDER: z.enum(["mock", "ecpay_stage"]).default("mock"),
    DEMO_TWD_PER_USDC: z.string().regex(/^\d+(?:\.\d+)?$/).default("32.0"),
    // Opt-in recovery-test fault injection, never part of the normal Demo flow.
    MOCK_INVOICE_FAIL_ONCE: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    WORKFLOW_POLL_INTERVAL_MS: z.coerce.number().int().min(25).max(60_000).default(250),
    WORKFLOW_LEASE_MS: z.coerce.number().int().min(5_000).max(30 * 60_000).default(60_000),
    WORKFLOW_BACKOFF_BASE_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
    WORKFLOW_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(3).default(3),
  })
  .superRefine((environment, context) => {
    if (environment.NODE_ENV === "production" && !environment.API_ACCESS_TOKEN) {
      context.addIssue({ code: "custom", path: ["API_ACCESS_TOKEN"], message: "Production API requires an access token" });
    }
    if (environment.PAYMENT_MODE === "x402" && !environment.EVM_PRIVATE_KEY) {
      context.addIssue({
        code: "custom",
        path: ["EVM_PRIVATE_KEY"],
        message: "EVM_PRIVATE_KEY is required when PAYMENT_MODE=x402",
      });
    }
    if (
      environment.PAYMENT_MODE === "x402" &&
      environment.USDC_TOKEN_ADDRESS.toLowerCase() !== BASE_SEPOLIA_USDC.toLowerCase()
    ) {
      context.addIssue({
        code: "custom",
        path: ["USDC_TOKEN_ADDRESS"],
        message: "PAYMENT_MODE=x402 requires the Base Sepolia Test USDC address",
      });
    }
    if (
      environment.PAYMENT_MODE === "x402" &&
      environment.USDC_TOKEN_DECIMALS !== USDC_DECIMALS
    ) {
      context.addIssue({
        code: "custom",
        path: ["USDC_TOKEN_DECIMALS"],
        message: `PAYMENT_MODE=x402 requires Test USDC decimals=${USDC_DECIMALS}`,
      });
    }
    if (
      environment.PAYMENT_MODE === "x402" &&
      environment.SELLER_CONTEXT_HMAC_SECRET === UNSAFE_CONTEXT_HMAC_SECRET
    ) {
      context.addIssue({
        code: "custom",
        path: ["SELLER_CONTEXT_HMAC_SECRET"],
        message:
          "A non-placeholder SELLER_CONTEXT_HMAC_SECRET is required when PAYMENT_MODE=x402",
      });
    }
    if (
      environment.CONTRACT_ANCHOR_MODE === "onchain" &&
      (!environment.CONTRACT_OPERATOR_PRIVATE_KEY || !environment.AUDIT_REGISTRY_ADDRESS)
    ) {
      context.addIssue({
        code: "custom",
        path: ["CONTRACT_ANCHOR_MODE"],
        message:
          "CONTRACT_OPERATOR_PRIVATE_KEY and AUDIT_REGISTRY_ADDRESS are required for onchain anchors",
      });
    }
    if (
      environment.PAYMENT_MODE === "x402" &&
      environment.CONTRACT_ANCHOR_MODE === "onchain" &&
      environment.AUDIT_REGISTRY_ADDRESS
    ) {
      for (const sellerField of ["SELLER_A_PAY_TO", "SELLER_B_PAY_TO"] as const) {
        if (
          environment[sellerField].toLowerCase() ===
          environment.AUDIT_REGISTRY_ADDRESS.toLowerCase()
        ) {
          context.addIssue({
            code: "custom",
            path: [sellerField],
            message: `${sellerField} cannot equal AUDIT_REGISTRY_ADDRESS; the audit contract must never receive payment funds`,
          });
        }
      }
    }
    if (!environment.ERC3009_RECORDING_ENABLED) {
      context.addIssue({
        code: "custom",
        path: ["ERC3009_RECORDING_ENABLED"],
        message:
          "ERC3009_RECORDING_ENABLED cannot be disabled because authorization evidence is mandatory in this P0 build",
      });
    }
    for (const feature of [
      "ERC8004_IDENTITY_ENABLED",
      "ERC8004_REPUTATION_ENABLED",
      "ERC8196_WALLET_ENABLED",
    ] as const) {
      if (environment[feature]) {
        context.addIssue({
          code: "custom",
          path: [feature],
          message: `${feature} is roadmap-only and is not implemented in this P0 build`,
        });
      }
    }
  });

export type AppConfig = z.infer<typeof EnvironmentSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  return EnvironmentSchema.parse(environment);
}
