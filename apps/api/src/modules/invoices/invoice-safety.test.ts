import { afterEach, describe, expect, it, vi } from "vitest";
import type { InvoiceAdapter, InvoiceIssueInput, InvoiceIssueResult } from "./mock-invoice-adapter.js";
import {
  issueInvoiceSafely,
  type InvoicePreflightInput,
} from "./invoice-safety.js";

const BUYER = "0x9999999999999999999999999999999999999999";
const SELLER = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7c";
const HASH = `0x${"1".repeat(64)}`;

const validPreflight: InvoicePreflightInput = {
  invoiceStatus: "PENDING",
  paymentStatus: "SETTLED",
  deliveryStatus: "DELIVERED",
  deliveryResponseHash: HASH,
  settlementTransactionHash: HASH,
  quotedAmountAtomic: "50000",
  registryQuoteAmountAtomic: "50000",
  actualAmountAtomic: "50000",
  settledAmountAtomic: "50000",
  buyerAddress: BUYER,
  payerAddress: BUYER.toUpperCase(),
  purchasePayeeAddress: SELLER,
  registryPayeeAddress: SELLER,
  settledPayeeAddress: SELLER.toUpperCase(),
  purchaseNetwork: "eip155:84532",
  registryNetwork: "eip155:84532",
  settledNetwork: "eip155:84532",
  purchaseTokenAddress: TOKEN,
  registryTokenAddress: TOKEN.toUpperCase(),
  settledTokenAddress: TOKEN,
  purchaseTokenSymbol: "USDC",
  registryTokenSymbol: "USDC",
  purchaseTokenDecimals: 6,
  registryTokenDecimals: 6,
  purchasePaymentId: "payment-1",
  authorizationPaymentId: "payment-1",
  serviceSupportsTwInvoice: true,
  sellerInvoiceCapability: "TW_B2B_DEMO",
  sellerInvoiceProvider: "MOCK",
  buyerBusinessId: "12345675",
  companyBusinessId: "12345675",
  sellerBusinessId: "24536806",
};

const issueInput: InvoiceIssueInput = {
  purchaseId: "00000000-0000-4000-8000-000000000010",
  buyerBusinessId: "12345675",
  sellerBusinessId: "24536806",
  sellerProfileId: "seller-b",
  sourceAmountAtomic: "50000",
  fxRateTwdPerUsdc: "32.0",
  itemName: "Example Co. 信用報告",
  paymentId: "payment-1",
  paymentTxHash: HASH,
  issuedAt: new Date("2030-01-01T00:00:00.000Z"),
};

const issuedInvoice: InvoiceIssueResult = {
  status: "ISSUED_DEMO",
  provider: "MOCK",
  providerReference: "DEMO-INV-1",
  invoiceNumber: "DEMO-INV-1",
  buyerBusinessId: "12345675",
  sellerBusinessId: "24536806",
  sellerProfileId: "seller-b",
  sourceAmountAtomic: "50000",
  fxRateTwdPerUsdc: "32.0",
  twdEquivalentMinor: "160",
  itemName: "Example Co. 信用報告",
  paymentId: "payment-1",
  paymentTxHash: HASH,
  canonicalHash: HASH as `0x${string}`,
  disclaimer: "電子發票模擬紀錄，非正式統一發票",
  issuedAt: "2030-01-01T00:00:00.000Z",
};

function adapter(
  issue: InvoiceAdapter["issue"] = vi.fn(async () => issuedInvoice),
): InvoiceAdapter {
  return { issue, getStatus: vi.fn(async () => "NOT_FOUND" as const) };
}

describe("invoice issuance safety boundary", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each<{
    label: string;
    patch: Partial<InvoicePreflightInput>;
    failedCheck: string;
  }>([
    { label: "unsettled payment", patch: { paymentStatus: "AUTHORIZED" }, failedCheck: "PAYMENT_SETTLED" },
    { label: "missing delivery", patch: { deliveryStatus: "FAILED" }, failedCheck: "DELIVERY_DELIVERED" },
    { label: "quote mismatch", patch: { settledAmountAtomic: "49999" }, failedCheck: "SETTLED_AMOUNT_MATCH" },
    { label: "actual mismatch", patch: { actualAmountAtomic: "49999" }, failedCheck: "ACTUAL_AMOUNT_MATCH" },
    { label: "payer mismatch", patch: { payerAddress: SELLER }, failedCheck: "PAYER_MATCH" },
    { label: "registry payee mismatch", patch: { settledPayeeAddress: BUYER }, failedCheck: "SETTLED_PAYEE_MATCH" },
    { label: "network mismatch", patch: { settledNetwork: "eip155:1" }, failedCheck: "SETTLED_NETWORK_MATCH" },
    { label: "token mismatch", patch: { settledTokenAddress: SELLER }, failedCheck: "SETTLED_TOKEN_MATCH" },
    { label: "signed payment ID mismatch", patch: { authorizationPaymentId: "payment-2" }, failedCheck: "PAYMENT_ID_MATCH" },
    { label: "missing signed payment ID", patch: { authorizationPaymentId: null }, failedCheck: "PAYMENT_ID_MATCH" },
    { label: "unsupported invoice seller", patch: { serviceSupportsTwInvoice: false }, failedCheck: "SELLER_SERVICE_INVOICE_CAPABLE" },
    { label: "invalid buyer business ID", patch: { buyerBusinessId: "12345678" }, failedCheck: "BUYER_BUSINESS_ID_VALID" },
    { label: "invalid seller business ID", patch: { sellerBusinessId: "12345678" }, failedCheck: "SELLER_BUSINESS_ID_VALID" },
  ])("does not call the adapter for $label", async ({ patch, failedCheck }) => {
    const issue = vi.fn(async () => issuedInvoice);
    const result = await issueInvoiceSafely({
      adapter: adapter(issue),
      preflight: { ...validPreflight, ...patch },
      issue: issueInput,
    });

    expect(result.kind).toBe("PRECONDITION_FAILED");
    if (result.kind !== "PRECONDITION_FAILED") throw new Error("Expected preflight failure");
    expect(result.preflight.failedCheckIds).toContain(failedCheck);
    expect(issue).not.toHaveBeenCalled();
  });

  it("does not issue a second invoice when one already succeeded", async () => {
    const issue = vi.fn(async () => issuedInvoice);
    await expect(
      issueInvoiceSafely({
        adapter: adapter(issue),
        preflight: { ...validPreflight, invoiceStatus: "ISSUED_DEMO" },
        issue: issueInput,
      }),
    ).resolves.toMatchObject({ kind: "ALREADY_ISSUED" });
    expect(issue).not.toHaveBeenCalled();
  });

  it("aborts a never-resolving adapter at the configured timeout as retryable", async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | undefined;
    const issue = vi.fn((input: InvoiceIssueInput) => {
      receivedSignal = input.signal;
      return new Promise<InvoiceIssueResult>(() => undefined);
    });
    const pending = issueInvoiceSafely({
      adapter: adapter(issue),
      preflight: validPreflight,
      issue: issueInput,
      timeoutMs: 25,
    });
    const assertion = expect(pending).rejects.toMatchObject({
      retryable: true,
      message: "Invoice adapter timed out after 25ms",
    });

    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(issue).toHaveBeenCalledOnce();
    expect(receivedSignal?.aborted).toBe(true);
  });
});
