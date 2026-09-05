import { BASE_SEPOLIA_USDC, MELLO_NETWORK } from "@mello/shared";
import {
  createTwEinvoiceSettlementMetadata,
  declareTwEinvoiceExtension,
  TW_EINVOICE_EXTENSION_KEY,
} from "@mello/tw-einvoice-extension";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentRequired, SettleResponse } from "@x402/core/types";
import {
  declarePaymentIdentifierExtension,
  extractPaymentIdentifier,
} from "@x402/extensions/payment-identifier";
import { describe, expect, it, vi } from "vitest";
import type { PreparePaymentInput } from "./payment-provider.js";
import { X402PaymentProvider } from "./x402-payment-provider.js";

const privateKey =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const payTo = "0x2222222222222222222222222222222222222222" as const;
const settlementReceiptVerifier = { verify: async (): Promise<void> => undefined };

function requiredResponse(amount = "50000"): PaymentRequired {
  return {
    x402Version: 2,
    error: "Payment required",
    resource: {
      url: "https://seller.example/v1/credit-report",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: MELLO_NETWORK,
        asset: BASE_SEPOLIA_USDC,
        amount,
        payTo,
        maxTimeoutSeconds: 300,
        extra: {
          name: "USDC",
          version: "2",
          assetTransferMethod: "eip3009",
          assetDecimals: 6,
        },
      },
    ],
    extensions: {
      "payment-identifier": declarePaymentIdentifierExtension(true),
      [TW_EINVOICE_EXTENSION_KEY]: declareTwEinvoiceExtension("seller-b"),
    },
  };
}

const baseInput: Omit<PreparePaymentInput, "payerAddress"> = {
  taskId: "00000000-0000-4000-8000-000000000101",
  requestId: "request-x402-provider",
  purchaseId: "00000000-0000-4000-8000-000000000010",
  paymentId: "pay_00000000000000000000000000000010",
  sellerId: "seller-b",
  endpoint: "https://seller.example/v1/credit-report",
  targetCompanyName: "Example Co.",
  purchaseContextToken: "signed-context",
  requiresTwInvoice: true,
  network: MELLO_NETWORK,
  tokenAddress: BASE_SEPOLIA_USDC,
  payToAddress: payTo,
  amountAtomic: "50000",
  authorizationTtlSeconds: 300,
  maximumValidBefore: BigInt(Math.floor(Date.now() / 1_000)) + 570n,
};

const validReport = {
  reportId: "rpt_test",
  provider: "seller-b",
  targetCompanyName: "Example Co.",
  riskScore: 72,
  riskLevel: "MEDIUM",
  summary: "Demo credit report only",
  generatedAt: "2026-09-04T12:00:00.000Z",
};

function createFetch(
  paymentRequired = requiredResponse(),
  report: unknown = validReport,
  settlementOverrides: Partial<SettleResponse> = {},
): {
  fetchImplementation: typeof globalThis.fetch;
  paidCalls: () => number;
} {
  let paid = 0;
  const fetchImplementation: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    expect(request.headers.get("x-request-id")).toBe(baseInput.requestId);
    expect(request.headers.get("x-mello-task-id")).toBe(baseInput.taskId);
    const signature = request.headers.get("payment-signature");
    if (!signature) {
      return new Response(JSON.stringify({ error: "Payment required" }), {
        status: 402,
        headers: {
          "content-type": "application/json",
          "payment-required": encodePaymentRequiredHeader(paymentRequired),
        },
      });
    }

    paid += 1;
    const payload = decodePaymentSignatureHeader(signature);
    expect(extractPaymentIdentifier(payload)).toBe(baseInput.paymentId);
    const authorization = payload.payload["authorization"] as { from: string };
    return new Response(
      JSON.stringify(report),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "payment-response": encodePaymentResponseHeader({
            success: true,
            payer: authorization.from,
            transaction:
              "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            network: MELLO_NETWORK,
            amount: "50000",
            extensions: {
              [TW_EINVOICE_EXTENSION_KEY]:
                createTwEinvoiceSettlementMetadata("seller-b"),
            },
            ...settlementOverrides,
          }),
        },
      },
    );
  };
  return { fetchImplementation, paidCalls: () => paid };
}

describe("X402PaymentProvider", () => {
  it("pauses the wrapped paid request after signing until submit releases the gate", async () => {
    const transport = createFetch();
    const provider = new X402PaymentProvider({
      privateKey,
      rpcUrl: "https://sepolia.base.org",
      fetchImplementation: transport.fetchImplementation,
      readTokenBalance: async () => 1_000_000n,
      settlementReceiptVerifier,
      readChainId: async () => 84_532,
    });
    const payerAddress = await provider.getAddress();

    const prepared = await provider.prepare({ ...baseInput, payerAddress });

    expect(transport.paidCalls()).toBe(0);
    expect(prepared.authorization.status).toBe("SIGNED");
    expect(prepared.authorization.signatureHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(prepared.paymentRequired).toEqual(requiredResponse());
    expect(prepared.validatedTerms).toMatchObject({
      amountAtomic: "50000",
      payToAddress: payTo,
      network: MELLO_NETWORK,
      tokenAddress: BASE_SEPOLIA_USDC,
    });

    let paidCallsAtAuthorization: number | undefined;
    let released = false;
    const settled = await prepared.submit({
      onBeforePaidRequest: async () => {
        paidCallsAtAuthorization = transport.paidCalls();
      },
      onPaidRequestReleased: async () => {
        released = true;
      },
    });
    expect(paidCallsAtAuthorization).toBe(0);
    expect(released).toBe(true);
    expect(transport.paidCalls()).toBe(1);
    expect(settled.transactionHash).toMatch(/^0xbb/);
    expect(settled.verifiedChainId).toBe(84_532);
    expect(settled.report.provider).toBe("seller-b");
  });

  it("does not release a paid request when its durable audit boundary cannot be recorded", async () => {
    const transport = createFetch();
    const provider = new X402PaymentProvider({
      privateKey,
      rpcUrl: "https://sepolia.base.org",
      fetchImplementation: transport.fetchImplementation,
      readTokenBalance: async () => 1_000_000n,
      settlementReceiptVerifier,
      readChainId: async () => 84_532,
    });
    const prepared = await provider.prepare({
      ...baseInput,
      payerAddress: await provider.getAddress(),
    });

    await expect(
      prepared.submit({
        onBeforePaidRequest: async () => {
          throw new Error("audit database unavailable");
        },
      }),
    ).rejects.toThrow("audit database unavailable");
    expect(transport.paidCalls()).toBe(0);
  });

  it("does not treat a post-release audit failure as a safe pre-submission failure", async () => {
    const transport = createFetch();
    const provider = new X402PaymentProvider({
      privateKey,
      rpcUrl: "https://sepolia.base.org",
      fetchImplementation: transport.fetchImplementation,
      readTokenBalance: async () => 1_000_000n,
      settlementReceiptVerifier,
    });
    const prepared = await provider.prepare({
      ...baseInput,
      payerAddress: await provider.getAddress(),
    });

    await expect(
      prepared.submit({
        onPaidRequestReleased: async () => {
          throw new Error("post-release audit database unavailable");
        },
      }),
    ).rejects.toThrow("post-release audit database unavailable");
    await vi.waitFor(() => expect(transport.paidCalls()).toBe(1));
    await expect(prepared.submit()).rejects.toMatchObject({
      code: "X402_PAYMENT_FAILED",
      statusCode: 409,
    });
  });

  it("rejects a seller amount mismatch before signing or sending a paid request", async () => {
    const transport = createFetch(requiredResponse("50001"));
    const provider = new X402PaymentProvider({
      privateKey,
      rpcUrl: "https://sepolia.base.org",
      fetchImplementation: transport.fetchImplementation,
      readTokenBalance: async () => 1_000_000n,
      settlementReceiptVerifier,
    });

    await expect(
      provider.prepare({ ...baseInput, payerAddress: await provider.getAddress() }),
    ).rejects.toMatchObject({ code: "ERC3009_TERMS_MISMATCH" });
    expect(transport.paidCalls()).toBe(0);
  });

  it("offers mismatched live terms to policy before the SDK can sign", async () => {
    const requirement = requiredResponse();
    requirement.accepts[0]!.payTo =
      "0x3333333333333333333333333333333333333333";
    const transport = createFetch(requirement);
    const provider = new X402PaymentProvider({
      privateKey,
      rpcUrl: "https://sepolia.base.org",
      fetchImplementation: transport.fetchImplementation,
      readTokenBalance: async () => 1_000_000n,
      settlementReceiptVerifier,
    });
    const onLivePaymentTerms = vi.fn(async () => {
      throw new Error("policy rejected live payee");
    });

    await expect(
      provider.prepare({
        ...baseInput,
        payerAddress: await provider.getAddress(),
        onLivePaymentTerms,
      }),
    ).rejects.toThrow("x402 request failed");
    expect(onLivePaymentTerms).toHaveBeenCalledWith(
      expect.objectContaining({ payToAddress: requirement.accepts[0]!.payTo }),
    );
    expect(transport.paidCalls()).toBe(0);
  });

  it("does not wrap raw upstream credentials into an x402 domain error", async () => {
    const provider = new X402PaymentProvider({
      privateKey,
      rpcUrl: "https://sepolia.base.org",
      fetchImplementation: vi.fn<typeof globalThis.fetch>(),
      readTokenBalance: async () => {
        throw new Error(
          "balance RPC https://example.quiknode.pro/QUICKNODE_SENTINEL " +
            "postgresql://mello:DB_SENTINEL@localhost/mello",
        );
      },
      settlementReceiptVerifier,
    });

    const failure = await provider
      .prepare({ ...baseInput, payerAddress: await provider.getAddress() })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "X402_PAYMENT_FAILED",
      message: "x402 request failed",
      retryable: true,
    });
    expect(JSON.stringify(failure)).not.toContain("QUICKNODE_SENTINEL");
    expect(JSON.stringify(failure)).not.toContain("DB_SENTINEL");
  });

  it("rejects a wrong ERC-3009 EIP-712 domain before signing", async () => {
    const requirement = requiredResponse();
    requirement.accepts[0]!.extra = { name: "Malicious Coin", version: "2" };
    const transport = createFetch(requirement);
    const provider = new X402PaymentProvider({
      privateKey,
      rpcUrl: "https://sepolia.base.org",
      fetchImplementation: transport.fetchImplementation,
      readTokenBalance: async () => 1_000_000n,
      settlementReceiptVerifier,
    });

    await expect(
      provider.prepare({ ...baseInput, payerAddress: await provider.getAddress() }),
    ).rejects.toMatchObject({ code: "X402_REQUIREMENTS_INVALID" });
    expect(transport.paidCalls()).toBe(0);
  });

  it("rejects an unexpected declared facilitator before signing", async () => {
    const requirement = requiredResponse();
    requirement.accepts[0]!.extra = {
      ...requirement.accepts[0]!.extra,
      facilitator: "https://evil.example/facilitator",
    };
    const transport = createFetch(requirement);
    const provider = new X402PaymentProvider({
      privateKey,
      rpcUrl: "https://sepolia.base.org",
      fetchImplementation: transport.fetchImplementation,
      readTokenBalance: async () => 1_000_000n,
      settlementReceiptVerifier,
    });

    await expect(
      provider.prepare({
        ...baseInput,
        payerAddress: await provider.getAddress(),
        expectedFacilitatorUrl: "https://x402.org/facilitator",
      }),
    ).rejects.toMatchObject({ code: "X402_REQUIREMENTS_INVALID" });
    expect(transport.paidCalls()).toBe(0);
  });

  it("requires Seller B's tw-einvoice declaration even when the buyer did not request an invoice", async () => {
    const requirement = requiredResponse();
    delete requirement.extensions?.[TW_EINVOICE_EXTENSION_KEY];
    const transport = createFetch(requirement);
    const provider = new X402PaymentProvider({
      privateKey,
      rpcUrl: "https://sepolia.base.org",
      fetchImplementation: transport.fetchImplementation,
      readTokenBalance: async () => 1_000_000n,
      settlementReceiptVerifier,
    });

    await expect(
      provider.prepare({
        ...baseInput,
        requiresTwInvoice: false,
        payerAddress: await provider.getAddress(),
      }),
    ).rejects.toMatchObject({ code: "X402_REQUIREMENTS_INVALID" });
    expect(transport.paidCalls()).toBe(0);
  });

  it("preserves settlement evidence when Seller B omits tw-einvoice settlement metadata", async () => {
    const transport = createFetch(requiredResponse(), validReport, { extensions: {} });
    const provider = new X402PaymentProvider({
      privateKey,
      rpcUrl: "https://sepolia.base.org",
      fetchImplementation: transport.fetchImplementation,
      readTokenBalance: async () => 1_000_000n,
      settlementReceiptVerifier,
      readChainId: async () => 84_532,
    });
    const prepared = await provider.prepare({
      ...baseInput,
      requiresTwInvoice: false,
      payerAddress: await provider.getAddress(),
    });

    await expect(prepared.submit()).rejects.toMatchObject({
      code: "X402_PAYMENT_FAILED",
      settlement: {
        paymentId: baseInput.paymentId,
        transactionHash:
          "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    });
    expect(transport.paidCalls()).toBe(1);
  });

  it("rejects seller authorization requirements that outlive the purchase mandate", async () => {
    const requirement = requiredResponse();
    requirement.accepts[0]!.maxTimeoutSeconds = 600;
    const transport = createFetch(requirement);
    const provider = new X402PaymentProvider({
      privateKey,
      rpcUrl: "https://sepolia.base.org",
      fetchImplementation: transport.fetchImplementation,
      readTokenBalance: async () => 1_000_000n,
      settlementReceiptVerifier,
    });
    const nowSeconds = BigInt(Math.floor(Date.now() / 1_000));

    await expect(
      provider.prepare({
        ...baseInput,
        payerAddress: await provider.getAddress(),
        authorizationTtlSeconds: 3_600,
        maximumValidBefore: nowSeconds + 570n,
      }),
    ).rejects.toMatchObject({ code: "X402_REQUIREMENTS_INVALID" });
    expect(transport.paidCalls()).toBe(0);
  });

  it("keeps a signed authorization within the mandate when configured TTL is longer", async () => {
    const transport = createFetch();
    const provider = new X402PaymentProvider({
      privateKey,
      rpcUrl: "https://sepolia.base.org",
      fetchImplementation: transport.fetchImplementation,
      readTokenBalance: async () => 1_000_000n,
      settlementReceiptVerifier,
    });
    const maximumValidBefore = BigInt(Math.floor(Date.now() / 1_000)) + 570n;

    const prepared = await provider.prepare({
      ...baseInput,
      payerAddress: await provider.getAddress(),
      authorizationTtlSeconds: 3_600,
      maximumValidBefore,
    });

    expect(prepared.authorization.validBefore).toBeLessThanOrEqual(maximumValidBefore);
    prepared.cancel();
  });

  it("fails the fund check before contacting the seller", async () => {
    let fetchCalls = 0;
    const provider = new X402PaymentProvider({
      privateKey,
      rpcUrl: "https://sepolia.base.org",
      fetchImplementation: async () => {
        fetchCalls += 1;
        return new Response();
      },
      readTokenBalance: async () => 49_999n,
      settlementReceiptVerifier,
    });

    await expect(
      provider.prepare({ ...baseInput, payerAddress: await provider.getAddress() }),
    ).rejects.toMatchObject({ code: "WALLET_INSUFFICIENT_FUNDS" });
    expect(fetchCalls).toBe(0);
  });

  it("preserves settlement evidence when the paid report is malformed", async () => {
    const transport = createFetch(requiredResponse(), { reportId: "missing-required-fields" });
    const provider = new X402PaymentProvider({
      privateKey,
      rpcUrl: "https://sepolia.base.org",
      fetchImplementation: transport.fetchImplementation,
      readTokenBalance: async () => 1_000_000n,
      settlementReceiptVerifier,
      readChainId: async () => 84_532,
    });

    const prepared = await provider.prepare({
      ...baseInput,
      payerAddress: await provider.getAddress(),
    });

    await expect(prepared.submit()).rejects.toMatchObject({
      code: "SERVICE_DELIVERY_FAILED",
      settlement: {
        paymentId: baseInput.paymentId,
        amountAtomic: baseInput.amountAtomic,
        transactionHash:
          "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    });
    expect(transport.paidCalls()).toBe(1);
  });

  it("never quarantines an invalid report while receipt verification is pending", async () => {
    const transport = createFetch(requiredResponse(), { reportId: "missing-required-fields" });
    const provider = new X402PaymentProvider({
      privateKey,
      rpcUrl: "https://sepolia.base.org",
      fetchImplementation: transport.fetchImplementation,
      readTokenBalance: async () => 1_000_000n,
      settlementReceiptVerifier: {
        verify: async () => {
          throw new Error("receipt timeout");
        },
      },
    });

    const result = (
      await provider.prepare({
        ...baseInput,
        payerAddress: await provider.getAddress(),
      })
    ).submit();

    const error = await result.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      evidence: { paymentId: baseInput.paymentId },
    });
    expect("report" in (error as { evidence: object }).evidence).toBe(false);
  });

  it("retries a network-lost paid response with the same signed payload", async () => {
    const successfulTransport = createFetch();
    const paidSignatures: string[] = [];
    const flakyFetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const signature = request.headers.get("payment-signature");
      if (signature) {
        paidSignatures.push(signature);
        if (paidSignatures.length === 1) {
          throw new TypeError("simulated connection reset after settlement");
        }
      }
      return successfulTransport.fetchImplementation(request);
    };
    const provider = new X402PaymentProvider({
      privateKey,
      rpcUrl: "https://sepolia.base.org",
      fetchImplementation: flakyFetch,
      readTokenBalance: async () => 1_000_000n,
      retryDelayMs: () => 0,
      settlementReceiptVerifier,
      readChainId: async () => 84_532,
    });
    const prepared = await provider.prepare({
      ...baseInput,
      payerAddress: await provider.getAddress(),
    });

    const settled = await prepared.submit();

    expect(settled.transactionHash).toMatch(/^0xbb/u);
    expect(paidSignatures).toHaveLength(2);
    expect(paidSignatures[1]).toBe(paidSignatures[0]);
    expect(successfulTransport.paidCalls()).toBe(1);
  });

  it("derives settlement terms from the approved purchase and verifies them on-chain", async () => {
    const transactionHash =
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
    const verify = vi.fn(async (): Promise<void> => undefined);
    const transport = createFetch(requiredResponse(), validReport, {
      // Optional facilitator fields are deliberately untrusted and may be false.
      payer: "0x3333333333333333333333333333333333333333",
      amount: "1",
    });
    const provider = new X402PaymentProvider({
      privateKey,
      rpcUrl: "https://sepolia.base.org",
      fetchImplementation: transport.fetchImplementation,
      readTokenBalance: async () => 1_000_000n,
      settlementReceiptVerifier: { verify },
      readChainId: async () => 84_532,
    });
    const payerAddress = await provider.getAddress();

    const settled = await (
      await provider.prepare({ ...baseInput, payerAddress })
    ).submit();

    expect(verify).toHaveBeenCalledWith({
      transactionHash,
      tokenAddress: BASE_SEPOLIA_USDC,
      payerAddress,
      payeeAddress: payTo,
      amountAtomic: baseInput.amountAtomic,
    });
    expect(settled).toMatchObject({
      transactionHash,
      payerAddress,
      payeeAddress: payTo,
      amountAtomic: baseInput.amountAtomic,
    });
  });

  it("never promotes a receipt verified through a non-Base-Sepolia RPC", async () => {
    const transport = createFetch();
    const provider = new X402PaymentProvider({
      privateKey,
      rpcUrl: "https://wrong-chain.example",
      fetchImplementation: transport.fetchImplementation,
      readTokenBalance: async () => 1_000_000n,
      settlementReceiptVerifier,
      readChainId: async () => 1,
    });
    const payerAddress = await provider.getAddress();
    const prepared = await provider.prepare({ ...baseInput, payerAddress });

    await expect(prepared.submit()).rejects.toMatchObject({
      code: "X402_PAYMENT_FAILED",
      evidence: { paymentId: baseInput.paymentId },
    });
    await expect(
      provider.verifySettlement({
        paymentId: baseInput.paymentId,
        transactionHash:
          "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        payerAddress,
        payeeAddress: payTo,
        amountAtomic: baseInput.amountAtomic,
        network: MELLO_NETWORK,
        tokenAddress: BASE_SEPOLIA_USDC,
        paymentResponse: { success: true },
      }),
    ).rejects.toMatchObject({ code: "X402_PAYMENT_FAILED" });
  });

  it("re-verifies a stored candidate receipt without making an HTTP payment request", async () => {
    const verify = vi.fn(async (): Promise<void> => undefined);
    const fetchImplementation = vi.fn<typeof globalThis.fetch>();
    const provider = new X402PaymentProvider({
      privateKey,
      rpcUrl: "https://sepolia.base.org",
      fetchImplementation,
      readTokenBalance: async () => 1_000_000n,
      settlementReceiptVerifier: { verify },
      readChainId: async () => 84_532,
    });
    const payerAddress = await provider.getAddress();
    const transactionHash =
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;

    await provider.verifySettlement({
      paymentId: baseInput.paymentId,
      transactionHash,
      payerAddress,
      payeeAddress: payTo,
      amountAtomic: baseInput.amountAtomic,
      network: MELLO_NETWORK,
      tokenAddress: BASE_SEPOLIA_USDC,
      paymentResponse: { success: true, transaction: transactionHash },
    });

    expect(verify).toHaveBeenCalledWith({
      transactionHash,
      tokenAddress: BASE_SEPOLIA_USDC,
      payerAddress,
      payeeAddress: payTo,
      amountAtomic: baseInput.amountAtomic,
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("does not accept a successful PAYMENT-RESPONSE when receipt verification fails", async () => {
    const transport = createFetch();
    const privateKeySentinel = `0x${"ab".repeat(32)}`;
    const provider = new X402PaymentProvider({
      privateKey,
      rpcUrl: "https://sepolia.base.org",
      fetchImplementation: transport.fetchImplementation,
      readTokenBalance: async () => 1_000_000n,
      settlementReceiptVerifier: {
        verify: async () => {
          throw new Error(
            "receipt provider https://base-sepolia.g.alchemy.com/v2/ALCHEMY_SENTINEL " +
              `Bearer BEARER_SENTINEL ${privateKeySentinel}`,
          );
        },
      },
    });

    const failure = await (await provider.prepare({
        ...baseInput,
        payerAddress: await provider.getAddress(),
      })).submit().catch((error: unknown) => error);
    expect(failure).toMatchObject({
      message:
        "Seller reported settlement, but its Base Sepolia receipt is not yet verified",
      evidence: { report: validReport },
    });
    const serializedFailure = JSON.stringify(failure);
    for (const secret of [
      "ALCHEMY_SENTINEL",
      "BEARER_SENTINEL",
      privateKeySentinel,
    ]) {
      expect(serializedFailure).not.toContain(secret);
    }
    expect(transport.paidCalls()).toBe(1);
  });
});
