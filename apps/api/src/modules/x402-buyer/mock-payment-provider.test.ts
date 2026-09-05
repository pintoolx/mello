import { BASE_SEPOLIA_USDC, MELLO_NETWORK } from "@mello/shared";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { declarePaymentIdentifierExtension } from "@x402/extensions/payment-identifier";
import { describe, expect, it, vi } from "vitest";
import { MockPaymentProvider } from "./mock-payment-provider.js";
import type { PreparePaymentInput } from "./payment-provider.js";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const NOW_SECONDS = BigInt(Math.floor(NOW.getTime() / 1_000));
const PAYER = "0x9999999999999999999999999999999999999999" as const;
const PAYEE = "0x2222222222222222222222222222222222222222" as const;

function paymentRequired(
  maxTimeoutSeconds: number,
  payTo: `0x${string}` = PAYEE,
): PaymentRequired {
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
        amount: "50000",
        payTo,
        maxTimeoutSeconds,
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
    },
  };
}

function unpaidFetch(
  maxTimeoutSeconds: number,
  payTo: `0x${string}` = PAYEE,
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    expect(request.headers.get("x-request-id")).toBe(baseInput.requestId);
    expect(request.headers.get("x-mello-task-id")).toBe(baseInput.taskId);
    return new Response(JSON.stringify({ error: "Payment required" }), {
      status: 402,
      headers: {
        "content-type": "application/json",
        "payment-required": encodePaymentRequiredHeader(
          paymentRequired(maxTimeoutSeconds, payTo),
        ),
      },
    });
  };
}

const baseInput: PreparePaymentInput = {
  taskId: "00000000-0000-4000-8000-000000000101",
  requestId: "request-mock-provider",
  purchaseId: "00000000-0000-4000-8000-000000000010",
  paymentId: "pay_00000000000000000000000000000010",
  sellerId: "seller-a",
  endpoint: "https://seller.example/v1/credit-report",
  targetCompanyName: "Example Co.",
  purchaseContextToken: "signed-context",
  requiresTwInvoice: false,
  network: MELLO_NETWORK,
  tokenAddress: BASE_SEPOLIA_USDC,
  payerAddress: PAYER,
  payToAddress: PAYEE,
  amountAtomic: "50000",
  authorizationTtlSeconds: 3_600,
  maximumValidBefore: NOW_SECONDS + 570n,
};

describe("MockPaymentProvider authorization validity", () => {
  it("uses the Seller timeout instead of a longer configured TTL", async () => {
    const provider = new MockPaymentProvider(PAYER, () => NOW, unpaidFetch(300));

    const prepared = await provider.prepare(baseInput);

    expect(prepared.authorization.validBefore).toBe(NOW_SECONDS + 300n);
    expect(prepared.authorization.validBefore).toBeLessThanOrEqual(
      baseInput.maximumValidBefore,
    );
  });

  it("rejects Seller requirements that would outlive the mandate bound", async () => {
    const provider = new MockPaymentProvider(PAYER, () => NOW, unpaidFetch(600));

    await expect(provider.prepare(baseInput)).rejects.toMatchObject({
      code: "X402_REQUIREMENTS_INVALID",
    });
  });

  it("runs the live policy callback before creating a mock authorization", async () => {
    const maliciousPayee =
      "0x3333333333333333333333333333333333333333" as const;
    const provider = new MockPaymentProvider(
      PAYER,
      () => NOW,
      unpaidFetch(300, maliciousPayee),
    );
    const onLivePaymentTerms = vi.fn(async () => {
      throw new Error("policy rejected live payee");
    });

    await expect(
      provider.prepare({ ...baseInput, onLivePaymentTerms }),
    ).rejects.toThrow("policy rejected live payee");
    expect(onLivePaymentTerms).toHaveBeenCalledWith(
      expect.objectContaining({ payToAddress: maliciousPayee }),
    );
  });
});
