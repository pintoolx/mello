import {
  DisabledAuditAnchorClient,
  MockAuditAnchorClient,
} from "@mello/contracts-client";
import type { PrismaClient } from "@mello/db";
import {
  CDP_FACILITATOR_URL,
  createFacilitatorClient,
  type CreateFacilitatorClientOptions,
} from "@mello/seller-kit";
import type { PaymentProvider } from "../modules/x402-buyer/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../config.js";
import {
  DefaultHealthService,
  type FacilitatorSupportClient,
  type HealthPublicClient,
} from "./default-health-service.js";

const BUYER_ADDRESS = "0x9999999999999999999999999999999999999999" as const;
const OPERATOR_PRIVATE_KEY = `0x${"2".repeat(64)}` as const;
const OPERATOR_ADDRESS = privateKeyToAccount(OPERATOR_PRIVATE_KEY).address;
type JwtGenerator = NonNullable<
  CreateFacilitatorClientOptions["jwtGenerator"]
>;

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakePrisma(): PrismaClient {
  return {
    $queryRawUnsafe: vi.fn(async () => [{ connected: 1 }]),
  } as unknown as PrismaClient;
}

function fakeFetch(): typeof fetch {
  return vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
}

function fakePublicClient(): HealthPublicClient {
  return {
    getChainId: vi.fn(async () => 84_532),
    getBalance: vi.fn(async () => 123n),
    getTransactionCount: vi.fn(async () => 7),
    readContract: vi.fn(async () => 456n),
  } as unknown as HealthPublicClient;
}

function fakePaymentProvider(mode: "mock" | "x402"): PaymentProvider {
  return {
    mode,
    getAddress: vi.fn(async () => BUYER_ADDRESS),
    prepare: vi.fn(),
  } as unknown as PaymentProvider;
}

function fakeFacilitatorClient(
  kinds: Awaited<ReturnType<FacilitatorSupportClient["getSupported"]>>["kinds"] = [
    { x402Version: 2, scheme: "exact", network: "eip155:84532" },
  ],
): FacilitatorSupportClient {
  return {
    getSupported: vi.fn(async () => ({ kinds, extensions: [], signers: {} })),
  };
}

function supportedResponse(): Response {
  return Response.json({
    kinds: [
      { x402Version: 2, scheme: "exact", network: "eip155:84532" },
    ],
    extensions: [],
    signers: {},
  });
}

describe("DefaultHealthService", () => {
  it("treats mock payment and disabled anchoring as intentional simulation modes", async () => {
    const publicClient = fakePublicClient();
    const fetchImplementation = fakeFetch();
    const anchorClient = new DisabledAuditAnchorClient();
    const hasContractCode = vi.spyOn(anchorClient, "hasContractCode");
    const service = new DefaultHealthService({
      prisma: fakePrisma(),
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://mello:mello@localhost:5432/mello_test",
        PAYMENT_MODE: "mock",
        CONTRACT_ANCHOR_MODE: "disabled",
      }),
      paymentProvider: fakePaymentProvider("mock"),
      anchorClient,
      publicClient,
      fetch: fetchImplementation,
      now: () => new Date("2026-09-04T00:00:00.000Z"),
    });

    const result = await service.check();

    expect(result).toMatchObject({
      status: "ok",
      checkedAt: "2026-09-04T00:00:00.000Z",
      modes: { payment: "mock", anchor: "disabled" },
      checks: {
        buyerWallet: {
          status: "ok",
          details: { address: BUYER_ADDRESS, simulated: true },
        },
        operatorWallet: {
          status: "ok",
          details: { mode: "disabled", required: false, skipped: true },
        },
        contract: {
          status: "ok",
          details: { mode: "disabled", address: null, skipped: true },
        },
        facilitator: {
          status: "ok",
          details: { mode: "mock", required: false, skipped: true },
        },
        baseRpc: {
          status: "ok",
          details: { required: false, skipped: true },
        },
      },
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(publicClient.getBalance).not.toHaveBeenCalled();
    expect(publicClient.getTransactionCount).not.toHaveBeenCalled();
    expect(publicClient.readContract).not.toHaveBeenCalled();
    expect(publicClient.getChainId).not.toHaveBeenCalled();
    expect(hasContractCode).not.toHaveBeenCalled();
  });

  it("reports only the on-chain contract operator public address and native balance", async () => {
    const publicClient = fakePublicClient();
    const service = new DefaultHealthService({
      prisma: fakePrisma(),
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://mello:mello@localhost:5432/mello_test",
        PAYMENT_MODE: "mock",
        BASE_SEPOLIA_RPC_URL: "http://127.0.0.1:8545",
        CONTRACT_ANCHOR_MODE: "onchain",
        CONTRACT_OPERATOR_PRIVATE_KEY: OPERATOR_PRIVATE_KEY,
        AUDIT_REGISTRY_ADDRESS: "0x3333333333333333333333333333333333333333",
      }),
      paymentProvider: fakePaymentProvider("mock"),
      anchorClient: new MockAuditAnchorClient(),
      publicClient,
      fetch: fakeFetch(),
    });

    const result = await service.check();

    expect(result).toMatchObject({
      status: "ok",
      checks: {
        baseRpc: {
          status: "ok",
          details: { chainId: 84_532, loopback: true },
        },
        operatorWallet: {
          status: "ok",
          details: {
            address: OPERATOR_ADDRESS,
            nativeBalanceAtomic: "123",
          },
        },
      },
    });
    expect(publicClient.getBalance).toHaveBeenCalledOnce();
    expect(publicClient.getBalance).toHaveBeenCalledWith({
      address: OPERATOR_ADDRESS,
    });
    expect(JSON.stringify(result)).not.toContain(OPERATOR_PRIVATE_KEY);
  });

  it.each(["http://127.0.0.2:8545", "http://localhost.:8545"])(
    "marks the loopback RPC alias %s as local provenance",
    async (rpcUrl) => {
      const service = new DefaultHealthService({
        prisma: fakePrisma(),
        config: loadConfig({
          NODE_ENV: "test",
          DATABASE_URL: "postgresql://mello:mello@localhost:5432/mello_test",
          PAYMENT_MODE: "mock",
          BASE_SEPOLIA_RPC_URL: rpcUrl,
          CONTRACT_ANCHOR_MODE: "onchain",
          CONTRACT_OPERATOR_PRIVATE_KEY: OPERATOR_PRIVATE_KEY,
          AUDIT_REGISTRY_ADDRESS: "0x3333333333333333333333333333333333333333",
        }),
        paymentProvider: fakePaymentProvider("mock"),
        anchorClient: new MockAuditAnchorClient(),
        publicClient: fakePublicClient(),
        fetch: fakeFetch(),
      });

      expect(await service.check()).toMatchObject({
        checks: {
          baseRpc: {
            status: "ok",
            details: { chainId: 84_532, loopback: true },
          },
        },
      });
    },
  );

  it("checks native and USDC balances when real x402 payment is enabled", async () => {
    const publicClient = fakePublicClient();
    const facilitatorClient = fakeFacilitatorClient();
    const service = new DefaultHealthService({
      prisma: fakePrisma(),
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://mello:mello@localhost:5432/mello_test",
        PAYMENT_MODE: "x402",
        EVM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
        SELLER_CONTEXT_HMAC_SECRET: "test-only-random-context-secret-32-bytes",
        CONTRACT_ANCHOR_MODE: "mock",
      }),
      paymentProvider: fakePaymentProvider("x402"),
      anchorClient: new MockAuditAnchorClient(),
      publicClient,
      facilitatorClient,
      fetch: fakeFetch(),
    });

    const result = await service.check();

    expect(result).toMatchObject({
      status: "ok",
      modes: { payment: "x402", anchor: "mock" },
      checks: {
        buyerWallet: {
          status: "ok",
          details: {
            address: BUYER_ADDRESS,
            nativeBalanceAtomic: "123",
            usdcBalanceAtomic: "456",
            transactionCount: "7",
          },
        },
        contract: {
          status: "ok",
          details: { mode: "mock", simulated: true },
        },
        facilitator: {
          status: "ok",
          details: {
            reachable: true,
            x402Version: 2,
            scheme: "exact",
            network: "eip155:84532",
            assetTransferMethod: "seller-negotiated",
          },
        },
      },
    });
    expect(publicClient.getBalance).toHaveBeenCalledWith({ address: BUYER_ADDRESS });
    expect(publicClient.getTransactionCount).toHaveBeenCalledWith({
      address: BUYER_ADDRESS,
      blockTag: "pending",
    });
    expect(publicClient.readContract).toHaveBeenCalledOnce();
    expect(publicClient.getChainId).toHaveBeenCalledOnce();
    expect(facilitatorClient.getSupported).toHaveBeenCalledOnce();
  });

  it("uses the shared unauthenticated client for the public facilitator", async () => {
    const facilitatorFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        void input;
        void init;
        return supportedResponse();
      },
    );
    vi.stubGlobal("fetch", facilitatorFetch);
    const service = new DefaultHealthService({
      prisma: fakePrisma(),
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://mello:mello@localhost:5432/mello_test",
        PAYMENT_MODE: "x402",
        EVM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
        SELLER_CONTEXT_HMAC_SECRET: "test-only-random-context-secret-32-bytes",
        CONTRACT_ANCHOR_MODE: "mock",
        X402_FACILITATOR_URL: "https://x402.org/facilitator",
      }),
      paymentProvider: fakePaymentProvider("x402"),
      anchorClient: new MockAuditAnchorClient(),
      publicClient: fakePublicClient(),
      fetch: fakeFetch(),
    });

    expect(await service.check()).toMatchObject({
      checks: { facilitator: { status: "ok" } },
    });
    expect(facilitatorFetch).toHaveBeenCalledOnce();
    const [input, init] = facilitatorFetch.mock.calls[0] ?? [];
    expect(String(input)).toBe("https://x402.org/facilitator/supported");
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
  });

  it("uses the shared authenticated client for the CDP facilitator", async () => {
    const facilitatorFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        void input;
        void init;
        return supportedResponse();
      },
    );
    vi.stubGlobal("fetch", facilitatorFetch);
    const jwtGenerator = vi.fn(
      async (options: Parameters<JwtGenerator>[0]) =>
        `test-jwt:${options.requestMethod}:${options.requestPath}`,
    );
    const facilitatorClientFactory = vi.fn((facilitatorUrl: string) =>
      createFacilitatorClient(facilitatorUrl, {
        env: {
          CDP_API_KEY_ID: "test-key-id",
          CDP_API_KEY_SECRET: "test-api-key-secret",
        },
        jwtGenerator,
        timeoutMs: 5_000,
      }),
    );
    const service = new DefaultHealthService({
      prisma: fakePrisma(),
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://mello:mello@localhost:5432/mello_test",
        PAYMENT_MODE: "x402",
        EVM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
        SELLER_CONTEXT_HMAC_SECRET: "test-only-random-context-secret-32-bytes",
        CONTRACT_ANCHOR_MODE: "mock",
        X402_FACILITATOR_URL: CDP_FACILITATOR_URL,
      }),
      paymentProvider: fakePaymentProvider("x402"),
      anchorClient: new MockAuditAnchorClient(),
      publicClient: fakePublicClient(),
      facilitatorClientFactory,
      fetch: fakeFetch(),
    });

    expect(await service.check()).toMatchObject({
      checks: { facilitator: { status: "ok" } },
    });
    expect(facilitatorClientFactory).toHaveBeenCalledWith(
      CDP_FACILITATOR_URL,
    );
    expect(facilitatorFetch).toHaveBeenCalledOnce();
    const [input, init] = facilitatorFetch.mock.calls[0] ?? [];
    expect(String(input)).toBe(`${CDP_FACILITATOR_URL}/supported`);
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer test-jwt:GET:/platform/v2/x402/supported",
    );
    expect(jwtGenerator).toHaveBeenCalledTimes(3);
  });

  it("requires a zero USDC balance on the on-chain audit registry", async () => {
    const registryAddress = "0x3333333333333333333333333333333333333333" as const;
    const publicClient = {
      ...fakePublicClient(),
      readContract: vi.fn(async (input: { args?: readonly unknown[] }) =>
        input.args?.[0] === registryAddress ? 0n : 456n,
      ),
    } as unknown as HealthPublicClient;
    const service = new DefaultHealthService({
      prisma: fakePrisma(),
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://mello:mello@localhost:5432/mello_test",
        PAYMENT_MODE: "x402",
        EVM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
        SELLER_CONTEXT_HMAC_SECRET: "test-only-random-context-secret-32-bytes",
        CONTRACT_ANCHOR_MODE: "onchain",
        CONTRACT_OPERATOR_PRIVATE_KEY: OPERATOR_PRIVATE_KEY,
        AUDIT_REGISTRY_ADDRESS: registryAddress,
      }),
      paymentProvider: fakePaymentProvider("x402"),
      anchorClient: new MockAuditAnchorClient(),
      publicClient,
      facilitatorClient: fakeFacilitatorClient(),
      fetch: fakeFetch(),
    });

    expect(await service.check()).toMatchObject({
      status: "ok",
      checks: {
        registryTokenBalance: {
          status: "ok",
          details: { balanceAtomic: "0", required: true },
        },
      },
    });
    expect(publicClient.readContract).toHaveBeenCalledTimes(2);
  });

  it("degrades when the on-chain audit registry has received USDC", async () => {
    const registryAddress = "0x3333333333333333333333333333333333333333" as const;
    const publicClient = {
      ...fakePublicClient(),
      readContract: vi.fn(async (input: { args?: readonly unknown[] }) =>
        input.args?.[0] === registryAddress ? 1n : 456n,
      ),
    } as unknown as HealthPublicClient;
    const service = new DefaultHealthService({
      prisma: fakePrisma(),
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://mello:mello@localhost:5432/mello_test",
        PAYMENT_MODE: "x402",
        EVM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
        SELLER_CONTEXT_HMAC_SECRET: "test-only-random-context-secret-32-bytes",
        CONTRACT_ANCHOR_MODE: "onchain",
        CONTRACT_OPERATOR_PRIVATE_KEY: OPERATOR_PRIVATE_KEY,
        AUDIT_REGISTRY_ADDRESS: registryAddress,
      }),
      paymentProvider: fakePaymentProvider("x402"),
      anchorClient: new MockAuditAnchorClient(),
      publicClient,
      facilitatorClient: fakeFacilitatorClient(),
      fetch: fakeFetch(),
    });

    expect(await service.check()).toMatchObject({
      status: "degraded",
      checks: {
        registryTokenBalance: {
          status: "degraded",
          error: "Dependency check failed",
        },
      },
    });
  });

  it("degrades when the facilitator is reachable but cannot settle the required kind", async () => {
    const service = new DefaultHealthService({
      prisma: fakePrisma(),
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://mello:mello@localhost:5432/mello_test",
        PAYMENT_MODE: "x402",
        EVM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
        SELLER_CONTEXT_HMAC_SECRET: "test-only-random-context-secret-32-bytes",
        CONTRACT_ANCHOR_MODE: "mock",
      }),
      paymentProvider: fakePaymentProvider("x402"),
      anchorClient: new MockAuditAnchorClient(),
      publicClient: fakePublicClient(),
      facilitatorClient: fakeFacilitatorClient([
        { x402Version: 2, scheme: "exact", network: "eip155:8453" },
      ]),
      fetch: fakeFetch(),
    });

    expect(await service.check()).toMatchObject({
      status: "degraded",
      checks: {
        facilitator: { status: "degraded", error: "Dependency check failed" },
      },
    });
  });

  it("does not report a Seller 4xx health response as healthy", async () => {
    const fetchImplementation = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return new Response(null, { status: url.includes(":4011/") ? 404 : 200 });
    }) as unknown as typeof fetch;
    const service = new DefaultHealthService({
      prisma: fakePrisma(),
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://mello:mello@localhost:5432/mello_test",
        PAYMENT_MODE: "mock",
        CONTRACT_ANCHOR_MODE: "disabled",
      }),
      paymentProvider: fakePaymentProvider("mock"),
      anchorClient: new DisabledAuditAnchorClient(),
      publicClient: fakePublicClient(),
      fetch: fetchImplementation,
    });

    expect(await service.check()).toMatchObject({
      status: "degraded",
      checks: {
        sellers: {
          sellerA: { status: "degraded", error: "Dependency check failed" },
          sellerB: { status: "ok" },
        },
      },
    });
  });
});
