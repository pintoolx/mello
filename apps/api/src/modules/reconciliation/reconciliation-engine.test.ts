import { BASE_SEPOLIA_USDC } from "@mello/shared";
import { describe, expect, it } from "vitest";
import { reconcilePurchase, type ReconciliationInput } from "./reconciliation-engine.js";

const TX = `0x${"a".repeat(64)}`;
const BUYER = "0x9999999999999999999999999999999999999999";
const SELLER = "0x2222222222222222222222222222222222222222";
const PAYMENT_ID = "pay_00000000000000000000000000000010";
const token = { symbol: "USDC", address: BASE_SEPOLIA_USDC, decimals: 6 };

const input: ReconciliationInput = {
  service: {
    amountAtomic: "50000",
    payee: SELLER,
    network: "eip155:84532",
    token,
    sellerProfileId: "seller-b",
    sellerBusinessId: "24536806",
  },
  purchase: {
    expectedAmountAtomic: "50000",
    actualAmountAtomic: "50000",
    payee: SELLER,
    payer: BUYER,
    network: "eip155:84532",
    token,
    paymentId: PAYMENT_ID,
  },
  authorization: {
    paymentId: PAYMENT_ID,
    amountAtomic: "50000",
    payee: SELLER,
    payer: BUYER,
    network: "eip155:84532",
    tokenAddress: BASE_SEPOLIA_USDC,
    status: "SETTLED",
    settlementTransactionHash: TX,
  },
  payment: {
    paymentId: PAYMENT_ID,
    status: "SETTLED",
    transactionHash: TX,
    amountAtomic: "50000",
    payee: SELLER,
    payer: BUYER,
    network: "eip155:84532",
    tokenAddress: BASE_SEPOLIA_USDC,
  },
  invoiceRequired: true,
  invoice: {
    sourceAmountAtomic: "50000",
    buyerBusinessId: "12345675",
    sellerBusinessId: "24536806",
    sellerProfileId: "seller-b",
    paymentId: PAYMENT_ID,
    paymentTransactionHash: TX,
  },
  companyBusinessId: "12345675",
  deliveryResponseHash: TX,
};

function expectMismatch(override: Partial<ReconciliationInput>, checkId: string): void {
  const result = reconcilePurchase({ ...input, ...override });
  expect(result.status).toBe("MISMATCH");
  expect(result.checks.find((item) => item.id === checkId)).toMatchObject({ passed: false });
}

describe("reconciliation engine", () => {
  it("matches complete service, purchase, authorization, settlement, invoice, and delivery evidence", () => {
    const result = reconcilePurchase(input);
    expect(result.status).toBe("MATCHED");
    expect(result.checks).toHaveLength(27);
    expect(result.checks.every((item) => !item.required || item.passed)).toBe(true);
  });

  it.each([
    ["service amount", { service: { ...input.service, amountAtomic: "50001" } }, "SERVICE_AMOUNT_MATCH"],
    ["purchase actual amount", { purchase: { ...input.purchase, actualAmountAtomic: "50001" } }, "PURCHASE_ACTUAL_AMOUNT_MATCH"],
    ["authorization amount", { authorization: { ...input.authorization!, amountAtomic: "50001" } }, "AUTHORIZATION_AMOUNT_MATCH"],
    ["settled amount", { payment: { ...input.payment, amountAtomic: "50001" } }, "SETTLED_AMOUNT_MATCH"],
    ["purchase payee", { purchase: { ...input.purchase, payee: BUYER } }, "PAYEE_MATCH"],
    ["authorization payee", { authorization: { ...input.authorization!, payee: BUYER } }, "AUTHORIZATION_PAYEE_MATCH"],
    ["settled payee", { payment: { ...input.payment, payee: BUYER } }, "SETTLED_PAYEE_MATCH"],
    ["authorization payer", { authorization: { ...input.authorization!, payer: SELLER } }, "PAYER_MATCH"],
    ["settled payer", { payment: { ...input.payment, payer: SELLER } }, "SETTLED_PAYER_MATCH"],
    ["service network", { service: { ...input.service, network: "eip155:1" } }, "NETWORK_MATCH"],
    ["authorization network", { authorization: { ...input.authorization!, network: "eip155:1" } }, "AUTHORIZATION_NETWORK_MATCH"],
    ["settled network", { payment: { ...input.payment, network: "eip155:1" } }, "SETTLED_NETWORK_MATCH"],
    ["service token", { service: { ...input.service, token: { ...token, decimals: 18 } } }, "TOKEN_MATCH"],
    ["authorization token", { authorization: { ...input.authorization!, tokenAddress: BUYER } }, "AUTHORIZATION_TOKEN_MATCH"],
    ["settled token", { payment: { ...input.payment, tokenAddress: BUYER } }, "SETTLED_TOKEN_MATCH"],
    ["payment record ID", { payment: { ...input.payment, paymentId: `${PAYMENT_ID}-other` } }, "PAYMENT_ID_MATCH"],
    ["authorization payment ID", { authorization: { ...input.authorization!, paymentId: `${PAYMENT_ID}-other` } }, "AUTHORIZATION_PAYMENT_ID_MATCH"],
    ["authorization tx", { authorization: { ...input.authorization!, settlementTransactionHash: `0x${"b".repeat(64)}` } }, "SETTLEMENT_TX_MATCH"],
    ["invoice payment ID", { invoice: { ...input.invoice!, paymentId: `${PAYMENT_ID}-other` } }, "INVOICE_PAYMENT_ID_MATCH"],
    ["invoice tx", { invoice: { ...input.invoice!, paymentTransactionHash: `0x${"b".repeat(64)}` } }, "INVOICE_SETTLEMENT_TX_MATCH"],
    ["invoice source", { invoice: { ...input.invoice!, sourceAmountAtomic: "49999" } }, "INVOICE_SOURCE_AMOUNT_MATCH"],
  ] as const)("detects a %s mismatch", (_name, override, failedCheck) => {
    expectMismatch(override, failedCheck);
  });

  it("does not let an absent invoice hide an existing financial mismatch", () => {
    const result = reconcilePurchase({
      ...input,
      payment: { ...input.payment, amountAtomic: "50001" },
      invoice: null,
    });
    expect(result.status).toBe("MISMATCH");
    expect(result.checks.find((item) => item.id === "SETTLED_AMOUNT_MATCH")?.passed).toBe(false);
  });

  it("remains pending only when required invoice evidence is the unresolved part", () => {
    const result = reconcilePurchase({ ...input, invoice: null });
    expect(result.status).toBe("PENDING");
    expect(result.checks.find((item) => item.id === "INVOICE_PAYMENT_ID_MATCH")).toMatchObject({
      actual: "pending",
      passed: false,
      required: true,
    });
  });

  it("validates pending candidate financial evidence without requiring invoice or delivery", () => {
    const result = reconcilePurchase({
      ...input,
      scope: "SETTLEMENT",
      purchase: { ...input.purchase, actualAmountAtomic: null },
      payment: { ...input.payment, status: "SETTLEMENT_PENDING" },
      authorization: {
        ...input.authorization!,
        status: "SUBMITTED",
        settlementTransactionHash: null,
      },
      invoice: null,
      deliveryResponseHash: null,
    });
    expect(result.status).toBe("MATCHED");
    expect(result.checks.find((item) => item.id === "SETTLEMENT_TX_MATCH")?.required).toBe(false);
    expect(result.checks.find((item) => item.id === "DELIVERY_PRESENT")?.required).toBe(false);
  });

  it("fails closed when authorization evidence is missing", () => {
    expectMismatch({ authorization: null }, "AUTHORIZATION_PAYMENT_ID_MATCH");
  });
});
