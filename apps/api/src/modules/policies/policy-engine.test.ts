import { describe, expect, it } from "vitest";
import {
  DEFAULT_ALLOWED_TOKEN,
  DEMO_COMPANY,
  MELLO_NETWORK,
  type CompanyProfileInput,
  type PolicyInput,
  type PurchaseIntent,
  type ServiceRecord,
} from "@mello/shared";
import { evaluatePolicy } from "./policy-engine.js";
import type { ValidatedPaymentTerms } from "../x402-buyer/payment-provider.js";

const policy: PolicyInput & { version: number } = {
  version: 3,
  perTxLimitAtomic: "100000",
  dailyLimitAtomic: "1000000",
  requireTwInvoice: true,
  allowedNetworks: [MELLO_NETWORK],
  allowedTokens: [DEFAULT_ALLOWED_TOKEN],
  allowedSellerIds: ["seller-a", "seller-b"],
};
const intent: PurchaseIntent = {
  serviceCategory: "credit_report",
  targetCompanyName: "Example Co.",
  maxAmount: { atomic: "100000", display: "0.1", token: "USDC" },
  requiresTwInvoice: true,
  buyerBusinessId: DEMO_COMPANY.businessId,
  costCenter: DEMO_COMPANY.defaultCostCenter,
  networkPreference: MELLO_NETWORK,
  usedDemoDefaultTarget: false,
};
const service: ServiceRecord = {
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
};
const livePaymentTerms: ValidatedPaymentTerms = {
  scheme: "exact",
  network: MELLO_NETWORK,
  tokenAddress: DEFAULT_ALLOWED_TOKEN.address,
  tokenSymbol: "USDC",
  tokenDecimals: 6,
  payToAddress: service.payToAddress as `0x${string}`,
  amountAtomic: service.priceAtomic,
  transferMethod: "eip3009",
  facilitatorUrl: "https://x402.org/facilitator",
};

describe("policy engine", () => {
  function decide(
    overrides: {
      intent?: PurchaseIntent;
      service?: ServiceRecord;
      policy?: PolicyInput & { version: number };
      company?: CompanyProfileInput;
      dailySettledAtomic?: string;
      livePaymentTerms?: ValidatedPaymentTerms;
    } = {},
  ) {
    return evaluatePolicy({
      intent: overrides.intent ?? intent,
      service: overrides.service ?? service,
      policy: overrides.policy ?? policy,
      company: overrides.company ?? DEMO_COMPANY,
      dailySettledAtomic: overrides.dailySettledAtomic ?? "0",
      ...(overrides.livePaymentTerms
        ? {
            livePaymentTerms: overrides.livePaymentTerms,
            expectedFacilitatorUrl: "https://x402.org/facilitator",
          }
        : {}),
      now: new Date("2026-09-04T04:00:00.000Z"),
    });
  }

  function expectRejected(decision: ReturnType<typeof decide>, reason: string): void {
    expect(decision.approved).toBe(false);
    expect(decision.reasonCodes).toContain(reason);
  }

  it("approves deterministic terms", () => {
    const decision = decide();
    expect(decision.approved).toBe(true);
    expect(decision.dailySpendAfterAtomic).toBe("50000");
    expect(decision.evaluatedAt).toBe("2026-09-04T04:00:00.000Z");
    expect(decision.reasonCodes).toContain("INVOICE_SUPPORTED");
  });

  it("accepts the exact user, per-transaction, and daily amount boundaries", () => {
    const decision = decide({
      intent: { ...intent, maxAmount: { ...intent.maxAmount, atomic: "50000" } },
      policy: { ...policy, perTxLimitAtomic: "50000", dailyLimitAtomic: "1000000" },
      dailySettledAtomic: "950000",
    });
    expect(decision.approved).toBe(true);
    expect(decision.dailySpendBeforeAtomic).toBe("950000");
    expect(decision.dailySpendAfterAtomic).toBe("1000000");
  });

  it("rejects a price one atomic unit above the user budget", () => {
    expectRejected(
      decide({
        intent: { ...intent, maxAmount: { ...intent.maxAmount, atomic: "49999" } },
      }),
      "USER_BUDGET_EXCEEDED",
    );
  });

  it("rejects a price one atomic unit above the per-transaction limit", () => {
    expectRejected(
      decide({ policy: { ...policy, perTxLimitAtomic: "49999" } }),
      "PER_TX_LIMIT_EXCEEDED",
    );
  });

  it("rejects a daily total one atomic unit above the limit", () => {
    expectRejected(
      decide({ dailySettledAtomic: "950001" }),
      "DAILY_LIMIT_EXCEEDED",
    );
  });

  it("rejects a seller absent from the allowlist", () => {
    expectRejected(
      decide({ policy: { ...policy, allowedSellerIds: ["seller-a"] } }),
      "SELLER_NOT_ALLOWED",
    );
  });

  it("rejects a service network absent from policy", () => {
    expectRejected(
      decide({ policy: { ...policy, allowedNetworks: [] } }),
      "NETWORK_NOT_ALLOWED",
    );
  });

  it("rejects a service network different from intent preference", () => {
    expectRejected(
      decide({
        intent: { ...intent, networkPreference: "eip155:1" } as unknown as PurchaseIntent,
      }),
      "NETWORK_NOT_ALLOWED",
    );
  });

  it.each<{
    label: string;
    service: ServiceRecord;
  }>([
    {
      label: "symbol",
      service: { ...service, tokenSymbol: "EURC" } as unknown as ServiceRecord,
    },
    {
      label: "address",
      service: {
        ...service,
        tokenAddress: "0x1111111111111111111111111111111111111111",
      },
    },
    {
      label: "decimals",
      service: { ...service, tokenDecimals: 18 } as unknown as ServiceRecord,
    },
  ])("rejects a token $label mismatch", ({ service: mismatchedService }) => {
    expectRejected(decide({ service: mismatchedService }), "TOKEN_NOT_ALLOWED");
  });

  it("accepts a token address with different hex casing", () => {
    const decision = decide({
      service: {
        ...service,
        tokenAddress: service.tokenAddress.toUpperCase().replace("0X", "0x"),
      },
    });
    expect(decision.approved).toBe(true);
  });

  it.each([
    {
      label: "service declaration",
      changedService: { ...service, supportsTwInvoice: false },
    },
    {
      label: "seller capability",
      changedService: { ...service, invoiceCapability: "NONE" as const },
    },
  ])("rejects missing invoice capability in the $label", ({ changedService }) => {
    expectRejected(decide({ service: changedService }), "INVOICE_REQUIRED");
  });

  it("does not require invoice capability when neither policy nor intent requires it", () => {
    const decision = decide({
      intent: { ...intent, requiresTwInvoice: false },
      policy: { ...policy, requireTwInvoice: false },
      service: {
        ...service,
        supportsTwInvoice: false,
        invoiceCapability: "NONE",
        invoiceProvider: "NONE",
      },
    });
    expect(decision.approved).toBe(true);
    expect(decision.reasonCodes).toContain("INVOICE_NOT_REQUIRED");
  });

  it("rejects a valid buyer business ID that differs from the company", () => {
    expectRejected(
      decide({ intent: { ...intent, buyerBusinessId: "24536806" } }),
      "BUYER_BUSINESS_ID_INVALID",
    );
  });

  it("rejects an equal buyer business ID with an invalid checksum", () => {
    expectRejected(
      decide({
        intent: { ...intent, buyerBusinessId: "12345678" },
        company: { ...DEMO_COMPANY, businessId: "12345678" } as CompanyProfileInput,
      }),
      "BUYER_BUSINESS_ID_INVALID",
    );
  });

  it("accepts a pay-to address with different hex casing", () => {
    expect(
      decide({
        livePaymentTerms: {
          ...livePaymentTerms,
          payToAddress: service.payToAddress.toUpperCase() as `0x${string}`,
        },
      }).approved,
    ).toBe(true);
  });

  it("rejects a pay-to mismatch before signing", () => {
    const decision = decide({
      livePaymentTerms: {
        ...livePaymentTerms,
        payToAddress: "0x3333333333333333333333333333333333333333",
      },
    });
    expectRejected(decision, "PAY_TO_ADDRESS_MISMATCH");
  });

  it.each([
    ["amount", { amountAtomic: "50001" }, "PAYMENT_AMOUNT_MISMATCH"],
    ["network", { network: "eip155:1" }, "NETWORK_NOT_ALLOWED"],
    ["token", { tokenAddress: "0x1111111111111111111111111111111111111111" }, "TOKEN_NOT_ALLOWED"],
    ["facilitator", { facilitatorUrl: "https://evil.example" }, "FACILITATOR_NOT_ALLOWED"],
  ] as const)("rejects a live 402 %s mismatch", (_label, override, reason) => {
    expectRejected(
      decide({ livePaymentTerms: { ...livePaymentTerms, ...override } }),
      reason,
    );
  });

  it("records that live 402 terms were policy validated", () => {
    expect(decide({ livePaymentTerms }).reasonCodes).toContain(
      "LIVE_PAYMENT_TERMS_VALIDATED",
    );
  });

  it("keeps atomic arithmetic exact above Number.MAX_SAFE_INTEGER", () => {
    const aboveSafeInteger = "9007199254740993";
    const exactDailyLimit = "18014398509481986";
    const largeService = { ...service, priceAtomic: aboveSafeInteger };
    const largeIntent = {
      ...intent,
      maxAmount: { ...intent.maxAmount, atomic: aboveSafeInteger },
    };
    const largePolicy = {
      ...policy,
      perTxLimitAtomic: aboveSafeInteger,
      dailyLimitAtomic: exactDailyLimit,
    };
    const exact = decide({
      service: largeService,
      intent: largeIntent,
      policy: largePolicy,
      dailySettledAtomic: aboveSafeInteger,
    });
    expect(exact.approved).toBe(true);
    expect(exact.dailySpendAfterAtomic).toBe(exactDailyLimit);

    expectRejected(
      decide({
        service: largeService,
        intent: largeIntent,
        policy: { ...largePolicy, dailyLimitAtomic: "18014398509481985" },
        dailySettledAtomic: aboveSafeInteger,
      }),
      "DAILY_LIMIT_EXCEEDED",
    );
  });
});
