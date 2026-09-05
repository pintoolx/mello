import { isIP } from "node:net";
import type { AuditAnchorClient } from "@mello/contracts-client";
import type { PrismaClient } from "@mello/db";
import { createFacilitatorClient } from "@mello/seller-kit";
import { MELLO_NETWORK, RuntimeModesSchema } from "@mello/shared";
import type { FacilitatorClient } from "@x402/core/server";
import { createPublicClient, erc20Abi, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import type { AppConfig } from "../config.js";
import type { PaymentProvider } from "../modules/x402-buyer/index.js";
import type { HealthService } from "./contracts.js";

type ViemPublicClient = ReturnType<typeof createPublicClient>;
export type HealthPublicClient = Pick<
  ViemPublicClient,
  "getChainId" | "getBalance" | "getTransactionCount" | "readContract"
>;
export type FacilitatorSupportClient = Pick<FacilitatorClient, "getSupported">;
export type FacilitatorSupportClientFactory = (
  facilitatorUrl: string,
) => FacilitatorSupportClient;

interface HealthProbe {
  status: "ok" | "degraded";
  details?: unknown;
  error?: string;
}

async function probe(check: () => Promise<unknown>): Promise<HealthProbe> {
  try {
    return { status: "ok", details: await check() };
  } catch (error: unknown) {
    return {
      status: "degraded",
      error:
        error instanceof Error && error.message.startsWith("Unexpected chain ID")
          ? error.message
          : "Dependency check failed",
    };
  }
}

function healthUrl(baseUrl: string): string {
  return new URL("health", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function rpcUrlIsLoopback(rpcUrl: string): boolean {
  try {
    const hostname = new URL(rpcUrl).hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/u, "");
    return (
      hostname === "localhost" ||
      hostname === "::1" ||
      (isIP(hostname) === 4 && hostname.split(".")[0] === "127")
    );
  } catch {
    return false;
  }
}

export interface DefaultHealthServiceDependencies {
  prisma: PrismaClient;
  config: AppConfig;
  paymentProvider: PaymentProvider;
  anchorClient: AuditAnchorClient;
  publicClient?: HealthPublicClient | undefined;
  facilitatorClient?: FacilitatorSupportClient | undefined;
  facilitatorClientFactory?: FacilitatorSupportClientFactory | undefined;
  fetch?: typeof fetch | undefined;
  now?: (() => Date) | undefined;
}

export class DefaultHealthService implements HealthService {
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => Date;
  private readonly publicClient: HealthPublicClient;
  private readonly facilitatorClient: FacilitatorSupportClient | undefined;

  constructor(private readonly dependencies: DefaultHealthServiceDependencies) {
    this.fetchImplementation = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? (() => new Date());
    this.publicClient =
      dependencies.publicClient ??
      createPublicClient({
        chain: baseSepolia,
        transport: http(dependencies.config.BASE_SEPOLIA_RPC_URL, {
          timeout: 20_000,
          retryCount: 0,
        }),
      });
    this.facilitatorClient = dependencies.facilitatorClient;
    if (!this.facilitatorClient && dependencies.config.PAYMENT_MODE === "x402") {
      const factory =
        dependencies.facilitatorClientFactory ??
        ((facilitatorUrl: string) =>
          createFacilitatorClient(facilitatorUrl, { timeoutMs: 5_000 }));
      this.facilitatorClient = factory(
        dependencies.config.X402_FACILITATOR_URL,
      );
    }
  }

  async check(): Promise<unknown> {
    const { prisma, config, paymentProvider, anchorClient } = this.dependencies;
    const modes = {
      ...RuntimeModesSchema.parse({
        agent: config.AGENT_MODE,
        payment: config.PAYMENT_MODE,
        invoice: config.INVOICE_PROVIDER,
        anchor: config.CONTRACT_ANCHOR_MODE,
      }),
      offchainAuthorizationFallbackEnabled: config.DEMO_ALLOW_OFFCHAIN_AUTH,
    };

    const buyerWalletPromise =
      config.PAYMENT_MODE === "mock"
        ? probe(async () => ({
            address: await paymentProvider.getAddress(),
            simulated: true,
          }))
        : probe(async () => {
            const address = await paymentProvider.getAddress();
            const [nativeBalance, usdcBalance, transactionCount] = await Promise.all([
              this.publicClient.getBalance({ address }),
              this.publicClient.readContract({
                address: config.USDC_TOKEN_ADDRESS as Address,
                abi: erc20Abi,
                functionName: "balanceOf",
                args: [address],
              }),
              this.publicClient.getTransactionCount({ address, blockTag: "pending" }),
            ]);
            return {
              address,
              nativeBalanceAtomic: nativeBalance.toString(),
              usdcBalanceAtomic: usdcBalance.toString(),
              transactionCount: transactionCount.toString(),
            };
          });
    const operatorWalletPromise =
      config.CONTRACT_ANCHOR_MODE !== "onchain"
        ? Promise.resolve<HealthProbe>({
            status: "ok",
            details: {
              mode: config.CONTRACT_ANCHOR_MODE,
              required: false,
              skipped: true,
            },
          })
        : probe(async () => {
            if (!config.CONTRACT_OPERATOR_PRIVATE_KEY) {
              throw new Error("Contract operator is not configured");
            }
            const address = privateKeyToAccount(
              config.CONTRACT_OPERATOR_PRIVATE_KEY as Hex,
            ).address;
            const nativeBalance = await this.publicClient.getBalance({ address });
            return {
              address,
              nativeBalanceAtomic: nativeBalance.toString(),
            };
          });
    const contractPromise =
      config.CONTRACT_ANCHOR_MODE === "disabled"
        ? Promise.resolve<HealthProbe>({
            status: "ok",
            details: {
              mode: "disabled",
              address: null,
              skipped: true,
            },
          })
        : probe(async () => {
            const codePresent = await anchorClient.hasContractCode();
            if (!codePresent) throw new Error("Audit registry contract code is unavailable");
            return {
              mode: anchorClient.mode,
              address: config.AUDIT_REGISTRY_ADDRESS ?? null,
              codePresent,
              ...(config.CONTRACT_ANCHOR_MODE === "mock" ? { simulated: true } : {}),
            };
          });
    const registryTokenBalancePromise =
      config.PAYMENT_MODE !== "x402" || config.CONTRACT_ANCHOR_MODE !== "onchain"
        ? Promise.resolve<HealthProbe>({
            status: "ok",
            details: { required: false, skipped: true },
          })
        : probe(async () => {
            if (!config.AUDIT_REGISTRY_ADDRESS) {
              throw new Error("Audit registry address is not configured");
            }
            const balance = await this.publicClient.readContract({
              address: config.USDC_TOKEN_ADDRESS as Address,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [config.AUDIT_REGISTRY_ADDRESS as Address],
            });
            if (balance !== 0n) {
              throw new Error("Audit registry must not hold Test USDC");
            }
            return {
              registryAddress: config.AUDIT_REGISTRY_ADDRESS,
              tokenAddress: config.USDC_TOKEN_ADDRESS,
              balanceAtomic: balance.toString(),
              required: true,
            };
          });
    const facilitatorPromise =
      config.PAYMENT_MODE === "mock"
        ? Promise.resolve<HealthProbe>({
            status: "ok",
            details: { mode: "mock", required: false, skipped: true },
          })
        : probe(() => this.fetchFacilitatorSupport());
    const baseRpcPromise =
      config.PAYMENT_MODE === "x402" || config.CONTRACT_ANCHOR_MODE === "onchain"
        ? probe(async () => {
            const chainId = await this.publicClient.getChainId();
            if (chainId !== baseSepolia.id) {
              throw new Error(`Unexpected chain ID ${chainId}`);
            }
            return {
              chainId,
              loopback: rpcUrlIsLoopback(config.BASE_SEPOLIA_RPC_URL),
            };
          })
        : Promise.resolve<HealthProbe>({
            status: "ok",
            details: { required: false, skipped: true },
          });

    const [
      database,
      sellerA,
      sellerB,
      facilitator,
      baseRpc,
      buyerWallet,
      operatorWallet,
      contract,
      registryTokenBalance,
    ] =
      await Promise.all([
        probe(async () => {
          await prisma.$queryRawUnsafe("SELECT 1");
          return { connected: true };
        }),
        probe(() => this.fetchReachability(healthUrl(config.SELLER_A_URL))),
        probe(() => this.fetchReachability(healthUrl(config.SELLER_B_URL))),
        facilitatorPromise,
        baseRpcPromise,
        buyerWalletPromise,
        operatorWalletPromise,
        contractPromise,
        registryTokenBalancePromise,
      ]);

    const agent: HealthProbe =
      config.AGENT_MODE === "openai" && (!config.OPENAI_API_KEY || !config.OPENAI_MODEL)
        ? { status: "degraded", error: "OpenAI mode is missing API key or model" }
        : { status: "ok", details: { mode: config.AGENT_MODE } };
    const invoice: HealthProbe = {
      status: "ok",
      details: {
        mode: config.INVOICE_PROVIDER,
        failOnceEnabled:
          config.INVOICE_PROVIDER === "mock" && config.MOCK_INVOICE_FAIL_ONCE,
      },
    };
    const checks = {
      database,
      sellers: { sellerA, sellerB },
      facilitator,
      baseRpc,
      buyerWallet,
      operatorWallet,
      contract,
      registryTokenBalance,
      agent,
      invoice,
    };
    const probes = [
      database,
      sellerA,
      sellerB,
      facilitator,
      baseRpc,
      buyerWallet,
      operatorWallet,
      contract,
      registryTokenBalance,
      agent,
      invoice,
    ];

    return {
      status: probes.every(({ status }) => status === "ok") ? "ok" : "degraded",
      checkedAt: this.now().toISOString(),
      modes,
      checks,
    };
  }

  private async fetchReachability(url: string): Promise<unknown> {
    const response = await this.fetchImplementation(url, {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error(`Remote service returned HTTP ${response.status}`);
    }
    return { reachable: true, statusCode: response.status };
  }

  private async fetchFacilitatorSupport(): Promise<unknown> {
    if (!this.facilitatorClient) {
      throw new Error("Facilitator client is unavailable");
    }
    const supported = await this.facilitatorClient.getSupported();
    const exactBaseSepolia = supported.kinds.find(
      (kind) =>
        kind.x402Version === 2 &&
        kind.scheme === "exact" &&
        kind.network === MELLO_NETWORK,
    );
    if (!exactBaseSepolia) {
      throw new Error("Facilitator does not advertise x402 v2 exact on Base Sepolia");
    }
    const advertisedTransferMethod = exactBaseSepolia.extra?.["assetTransferMethod"];
    if (
      advertisedTransferMethod !== undefined &&
      advertisedTransferMethod !== "eip3009"
    ) {
      throw new Error("Facilitator advertises an incompatible asset transfer method");
    }
    return {
      reachable: true,
      x402Version: exactBaseSepolia.x402Version,
      scheme: exactBaseSepolia.scheme,
      network: exactBaseSepolia.network,
      assetTransferMethod: advertisedTransferMethod ?? "seller-negotiated",
    };
  }
}
