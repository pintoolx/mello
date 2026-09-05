import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ALLOWED_TOKEN,
  DEMO_COMPANY,
  DEMO_PROMPTS,
  MELLO_NETWORK,
  type PolicyInput,
  type ServiceRecord,
} from "@mello/shared";
import {
  evaluateCandidates,
  parsePurchaseIntentFallback,
  ProcurementAgent,
  selectCandidate,
} from "./index.js";

const policy: PolicyInput = {
  perTxLimitAtomic: "100000",
  dailyLimitAtomic: "1000000",
  requireTwInvoice: true,
  allowedNetworks: [MELLO_NETWORK],
  allowedTokens: [DEFAULT_ALLOWED_TOKEN],
  allowedSellerIds: ["seller-a", "seller-b"],
};

const services: ServiceRecord[] = [
  {
    id: "credit-report-a",
    sellerId: "seller-a",
    sellerLegalName: "Seller A",
    sellerBusinessId: null,
    payToAddress: "0x1111111111111111111111111111111111111111",
    invoiceCapability: "NONE",
    invoiceProvider: "NONE",
    category: "credit_report",
    endpoint: "http://localhost:4011/v1/credit-report",
    method: "POST",
    priceAtomic: "40000",
    tokenSymbol: "USDC",
    tokenAddress: DEFAULT_ALLOWED_TOKEN.address,
    tokenDecimals: 6,
    network: MELLO_NETWORK,
    supportsTwInvoice: false,
    active: true,
  },
  {
    id: "credit-report-b",
    sellerId: "seller-b",
    sellerLegalName: "Seller B",
    sellerBusinessId: "24536806",
    payToAddress: "0x2222222222222222222222222222222222222222",
    invoiceCapability: "TW_B2B_DEMO",
    invoiceProvider: "MOCK",
    category: "credit_report",
    endpoint: "http://localhost:4012/v1/credit-report",
    method: "POST",
    priceAtomic: "50000",
    tokenSymbol: "USDC",
    tokenAddress: DEFAULT_ALLOWED_TOKEN.address,
    tokenDecimals: 6,
    network: MELLO_NETWORK,
    supportsTwInvoice: true,
    active: true,
  },
];

describe("demo procurement parser", () => {
  it("parses the happy path without floating point", () => {
    const intent = parsePurchaseIntentFallback({
      prompt: DEMO_PROMPTS.happy,
      company: DEMO_COMPANY,
      policyPerTxLimitAtomic: policy.perTxLimitAtomic,
    });
    expect(intent).toMatchObject({
      serviceCategory: "credit_report",
      targetCompanyName: "Example Co.",
      maxAmount: { atomic: "100000", token: "USDC" },
      requiresTwInvoice: true,
      usedDemoDefaultTarget: false,
    });
  });

  it("uses the policy limit and flags the demo target when omitted", () => {
    const intent = parsePurchaseIntentFallback({
      prompt: "幫我買信用報告，要開發票",
      company: DEMO_COMPANY,
      policyPerTxLimitAtomic: policy.perTxLimitAtomic,
    });
    expect(intent.maxAmount.atomic).toBe("100000");
    expect(intent.targetCompanyName).toBe("Example Co.");
    expect(intent.usedDemoDefaultTarget).toBe(true);
  });

  it("formats a large policy default without crossing a floating-point boundary", () => {
    const intent = parsePurchaseIntentFallback({
      prompt: "幫我買信用報告，不需要發票",
      company: DEMO_COMPANY,
      policyPerTxLimitAtomic: "9007199254740993000001",
    });

    expect(intent.maxAmount).toEqual({
      atomic: "9007199254740993000001",
      display: "9007199254740993.000001",
      token: "USDC",
    });
  });

  it("uses the smallest explicit USDC amount when a prompt contains conflicting limits", () => {
    const intent = parsePurchaseIntentFallback({
      prompt: "幫我買 Example Co. 信用報告；舊上限 100 USDC，但本次預算只有 0.03 USDC。",
      company: DEMO_COMPANY,
      policyPerTxLimitAtomic: policy.perTxLimitAtomic,
    });

    expect(intent.maxAmount).toEqual({
      atomic: "30000",
      display: "0.03",
      token: "USDC",
    });
  });
});

describe("OpenAI procurement parser merge", () => {
  function fakeClient(outputParsed: unknown): OpenAI {
    return {
      responses: {
        parse: vi.fn(async () => ({ output_parsed: outputParsed })),
      },
    } as unknown as OpenAI;
  }

  const fallbackInput = {
    prompt: "幫我買 Example Co. 的信用報告，預算 0.1 USDC，要開統編發票。",
    company: DEMO_COMPANY,
    policyPerTxLimitAtomic: policy.perTxLimitAtomic,
  };

  it("uses policy and disclosed demo defaults when the model reports omitted fields", async () => {
    const result = await new ProcurementAgent({
      mode: "openai",
      model: "test-model",
      client: fakeClient({
        serviceCategory: "credit_report",
        targetCompanyName: null,
        maxAmountDisplay: null,
        requiresTwInvoice: true,
      }),
    }).parse({
      prompt: "幫我買信用報告，要開發票",
      company: DEMO_COMPANY,
      policyPerTxLimitAtomic: policy.perTxLimitAtomic,
    });

    expect(result.usedFallback).toBe(false);
    expect(result.intent).toMatchObject({
      targetCompanyName: "Example Co.",
      usedDemoDefaultTarget: true,
      maxAmount: { atomic: "100000", display: "0.1", token: "USDC" },
      requiresTwInvoice: true,
    });
  });

  it.each(["0.000001", "999999"])(
    "ignores a model-supplied %s USDC budget when the user omitted a budget",
    async (hallucinatedBudget) => {
      const result = await new ProcurementAgent({
        mode: "openai",
        model: "test-model",
        client: fakeClient({
          serviceCategory: "credit_report",
          targetCompanyName: null,
          maxAmountDisplay: hallucinatedBudget,
          requiresTwInvoice: true,
        }),
      }).parse({
        prompt: "幫我買信用報告，要開發票",
        company: DEMO_COMPANY,
        policyPerTxLimitAtomic: policy.perTxLimitAtomic,
      });

      expect(result.intent.maxAmount).toEqual({
        atomic: "100000",
        display: "0.1",
        token: "USDC",
      });
    },
  );

  it("uses validated semantic target and decimal budget without floating point", async () => {
    const result = await new ProcurementAgent({
      mode: "openai",
      model: "test-model",
      client: fakeClient({
        serviceCategory: "credit_report",
        targetCompanyName: "Acme Taiwan",
        maxAmountDisplay: "0.050001",
        requiresTwInvoice: false,
      }),
    }).parse({
      prompt: "Buy Acme Taiwan credit report for 0.050001 USDC",
      company: DEMO_COMPANY,
      policyPerTxLimitAtomic: policy.perTxLimitAtomic,
    });

    expect(result.intent).toMatchObject({
      targetCompanyName: "Acme Taiwan",
      usedDemoDefaultTarget: false,
      maxAmount: { atomic: "50001", display: "0.050001", token: "USDC" },
      requiresTwInvoice: false,
    });
  });

  it("does not let model output expand an explicit prompt budget or remove an invoice request", async () => {
    const result = await new ProcurementAgent({
      mode: "openai",
      model: "test-model",
      client: fakeClient({
        serviceCategory: "credit_report",
        targetCompanyName: "Example Co.",
        maxAmountDisplay: "100",
        requiresTwInvoice: false,
      }),
    }).parse({
      prompt: "幫我買 Example Co. 的信用報告，上限 100 USDC，但本次預算 0.03 USDC，要開發票。",
      company: DEMO_COMPANY,
      policyPerTxLimitAtomic: policy.perTxLimitAtomic,
    });

    expect(result.intent.maxAmount).toEqual({
      atomic: "30000",
      display: "0.03",
      token: "USDC",
    });
    expect(result.intent.requiresTwInvoice).toBe(true);
  });

  it("retries invalid model output exactly once before using the deterministic fallback", async () => {
    const parse = vi.fn(async (
      body: unknown,
      options?: { maxRetries?: number; timeout?: number; signal?: AbortSignal | null },
    ) => {
      void body;
      void options;
      throw new Error("invalid JSON");
    });
    const client = { responses: { parse } } as unknown as OpenAI;

    const result = await new ProcurementAgent({
      mode: "openai",
      model: "test-model",
      client,
    }).parse(fallbackInput);

    expect(parse).toHaveBeenCalledTimes(2);
    for (const [, requestOptions] of parse.mock.calls) {
      expect(requestOptions).toMatchObject({ maxRetries: 0 });
      expect(requestOptions?.timeout).toBeGreaterThan(0);
      expect(requestOptions?.timeout).toBeLessThanOrEqual(20_000);
      expect(requestOptions?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(result).toEqual({
      intent: parsePurchaseIntentFallback(fallbackInput),
      usedFallback: true,
      fallbackReason: "invalid JSON",
    });
  });

  it("uses one 20 second deadline for requests and backoff before falling back", async () => {
    vi.useFakeTimers();
    try {
      const parse = vi.fn((
        body: unknown,
        options?: { maxRetries?: number; timeout?: number; signal?: AbortSignal | null },
      ) => {
        void body;
        void options;
        return new Promise<never>(() => undefined);
      });
      const client = { responses: { parse } } as unknown as OpenAI;

      const pending = new ProcurementAgent({
        mode: "openai",
        model: "test-model",
        client,
      }).parse(fallbackInput);

      await vi.advanceTimersByTimeAsync(20_000);
      await expect(pending).resolves.toEqual({
        intent: parsePurchaseIntentFallback(fallbackInput),
        usedFallback: true,
        fallbackReason: "OpenAI parse exceeded the 20000ms total time budget",
      });
      expect(parse).toHaveBeenCalledTimes(1);
      expect(parse.mock.calls[0]?.[1]).toMatchObject({
        maxRetries: 0,
        timeout: 20_000,
      });
      expect(parse.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries an empty parsed response exactly once before using the deterministic fallback", async () => {
    const parse = vi.fn(async () => ({ output_parsed: null }));
    const client = { responses: { parse } } as unknown as OpenAI;

    const result = await new ProcurementAgent({
      mode: "openai",
      model: "test-model",
      client,
    }).parse(fallbackInput);

    expect(parse).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      intent: parsePurchaseIntentFallback(fallbackInput),
      usedFallback: true,
      fallbackReason: "OpenAI returned no parsed intent",
    });
  });

  it("maps a terminal deterministic parser failure to AGENT_PARSE_FAILED", async () => {
    const parse = vi.fn(async () => {
      throw new Error("model unavailable");
    });
    const client = { responses: { parse } } as unknown as OpenAI;

    const result = new ProcurementAgent({
      mode: "openai",
      model: "test-model",
      client,
    }).parse({
      prompt: "Buy an office chair",
      company: DEMO_COMPANY,
      policyPerTxLimitAtomic: policy.perTxLimitAtomic,
    });

    await expect(result).rejects.toMatchObject({
      name: "MelloError",
      code: "AGENT_PARSE_FAILED",
      retryable: false,
      details: {
        parser: "deterministic",
        reason: "請指定要搜尋的服務：個股分析、總經分析、加密市場資訊或期貨分析。",
      },
    });
    expect(parse).toHaveBeenCalledTimes(2);
  });
});

describe("candidate evaluation", () => {
  it("rejects A for invoice support and selects B", () => {
    const intent = parsePurchaseIntentFallback({
      prompt: DEMO_PROMPTS.happy,
      company: DEMO_COMPANY,
      policyPerTxLimitAtomic: policy.perTxLimitAtomic,
    });
    const result = evaluateCandidates({ intent, policy, services });
    expect(result.find((candidate) => candidate.sellerId === "seller-a")?.reasonCodes).toContain(
      "INVOICE_UNSUPPORTED",
    );
    expect(selectCandidate(result)).toMatchObject({
      sellerId: "seller-b",
      sellerLegalName: "Seller B",
      invoiceCapability: "TW_B2B_DEMO",
      supportsTwInvoice: true,
    });
  });

  it("has no eligible service under a 0.03 USDC budget", () => {
    const intent = parsePurchaseIntentFallback({
      prompt: DEMO_PROMPTS.rejected,
      company: DEMO_COMPANY,
      policyPerTxLimitAtomic: policy.perTxLimitAtomic,
    });
    const result = evaluateCandidates({ intent, policy, services });
    expect(selectCandidate(result)).toBeUndefined();
    expect(result.find((candidate) => candidate.sellerId === "seller-b")?.reasonCodes).toContain(
      "AMOUNT_OVER_USER_BUDGET",
    );
  });
});
