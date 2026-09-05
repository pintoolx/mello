import { calculateTwdMinorUnits, hashCanonicalJson, type InvoiceBuyerProfile } from "@mello/shared";

export interface InvoiceIssueInput {
  buyerProfile?: InvoiceBuyerProfile;
  purchaseId: string;
  buyerBusinessId: string;
  sellerBusinessId: string;
  sellerProfileId: string;
  sourceAmountAtomic: string;
  fxRateTwdPerUsdc: string;
  itemName: string;
  paymentId: string;
  paymentTxHash: string;
  issuedAt?: Date;
  signal?: AbortSignal;
}

export interface InvoiceIssueResult {
  status: "ISSUED_DEMO";
  provider: "MOCK";
  providerReference: string;
  invoiceNumber: string;
  buyerBusinessId: string;
  sellerBusinessId: string;
  sellerProfileId: string;
  sourceAmountAtomic: string;
  fxRateTwdPerUsdc: string;
  twdEquivalentMinor: string;
  itemName: string;
  paymentId: string;
  paymentTxHash: string;
  canonicalHash: `0x${string}`;
  disclaimer: string;
  issuedAt: string;
}

export interface InvoiceAdapter {
  /** Implementations must be idempotent for purchaseId + paymentId and honor abort signals. */
  issue(input: InvoiceIssueInput): Promise<InvoiceIssueResult>;
  getStatus(reference: string): Promise<"ISSUED_DEMO" | "NOT_FOUND">;
}

export class RetryableInvoiceError extends Error {
  readonly retryable = true;
}

export class MockInvoiceAdapter implements InvoiceAdapter {
  private readonly failedPurchases = new Set<string>();
  private readonly issuedReferences = new Set<string>();

  /** Normal Demo issues immediately; true is reserved for explicit fault-injection tests. */
  constructor(private readonly failOnce = false) {}

  async issue(input: InvoiceIssueInput): Promise<InvoiceIssueResult> {
    input.signal?.throwIfAborted();
    if (this.failOnce && !this.failedPurchases.has(input.purchaseId)) {
      this.failedPurchases.add(input.purchaseId);
      throw new RetryableInvoiceError("Mock invoice provider failed once as configured");
    }

    const issuedAt = input.issuedAt ?? new Date();
    const date = issuedAt.toISOString().slice(0, 10).replaceAll("-", "");
    const suffix = hashCanonicalJson({ purchaseId: input.purchaseId }).slice(2, 8).toUpperCase();
    const invoiceNumber = `DEMO-INV-${date}-${suffix}`;
    const twdEquivalentMinor = calculateTwdMinorUnits(
      input.sourceAmountAtomic,
      input.fxRateTwdPerUsdc,
    );
    const evidence = {
      schemaVersion: "1",
      invoiceMode: "B2B_DEMO",
      invoiceNumber,
      buyerBusinessId: input.buyerBusinessId,
      ...(input.buyerProfile ? { buyerProfile: input.buyerProfile } : {}),
      sellerBusinessId: input.sellerBusinessId,
      sellerProfileId: input.sellerProfileId,
      sourceAmountAtomic: input.sourceAmountAtomic,
      fxRateTwdPerUsdc: input.fxRateTwdPerUsdc,
      twdEquivalentMinor,
      itemName: input.itemName,
      paymentId: input.paymentId,
      paymentTxHash: input.paymentTxHash,
      issuedAt: issuedAt.toISOString(),
    };
    const canonicalHash = hashCanonicalJson(evidence);
    this.issuedReferences.add(invoiceNumber);

    return {
      status: "ISSUED_DEMO",
      provider: "MOCK",
      providerReference: invoiceNumber,
      invoiceNumber,
      buyerBusinessId: input.buyerBusinessId,
      sellerBusinessId: input.sellerBusinessId,
      sellerProfileId: input.sellerProfileId,
      sourceAmountAtomic: input.sourceAmountAtomic,
      fxRateTwdPerUsdc: input.fxRateTwdPerUsdc,
      twdEquivalentMinor,
      itemName: input.itemName,
      paymentId: input.paymentId,
      paymentTxHash: input.paymentTxHash,
      canonicalHash,
      disclaimer: "電子發票模擬紀錄，非正式統一發票",
      issuedAt: issuedAt.toISOString(),
    };
  }

  async getStatus(reference: string): Promise<"ISSUED_DEMO" | "NOT_FOUND"> {
    return this.issuedReferences.has(reference) ? "ISSUED_DEMO" : "NOT_FOUND";
  }
}

export function notRequiredInvoiceEvidenceHash(purchaseId: string): `0x${string}` {
  return hashCanonicalJson({
    schemaVersion: "1",
    purchaseId,
    invoiceStatus: "NOT_REQUIRED",
    reason: "BUYER_AND_POLICY_DID_NOT_REQUIRE_INVOICE",
  });
}
