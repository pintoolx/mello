import { hashCanonicalJson, isValidTaiwanBusinessId } from "@mello/shared";
import {
  RetryableInvoiceError,
  type InvoiceAdapter,
  type InvoiceIssueInput,
  type InvoiceIssueResult,
} from "./mock-invoice-adapter.js";

export interface InvoicePreflightInput {
  invoiceStatus: string;
  paymentStatus: string | null;
  deliveryStatus: string | null;
  deliveryResponseHash: string | null;
  settlementTransactionHash: string | null;
  quotedAmountAtomic: string;
  registryQuoteAmountAtomic: string;
  actualAmountAtomic: string | null;
  settledAmountAtomic: string | null;
  buyerAddress: string;
  payerAddress: string | null;
  purchasePayeeAddress: string;
  registryPayeeAddress: string;
  settledPayeeAddress: string | null;
  purchaseNetwork: string;
  registryNetwork: string;
  settledNetwork: string | null;
  purchaseTokenAddress: string;
  registryTokenAddress: string;
  settledTokenAddress: string | null;
  purchaseTokenSymbol: string;
  registryTokenSymbol: string;
  purchaseTokenDecimals: number;
  registryTokenDecimals: number;
  purchasePaymentId: string;
  authorizationPaymentId: string | null;
  serviceSupportsTwInvoice: boolean;
  sellerInvoiceCapability: string;
  sellerInvoiceProvider: string;
  buyerBusinessId: string;
  companyBusinessId: string;
  sellerBusinessId: string | null;
}

export interface InvoicePreflightCheck {
  id: string;
  expected: string;
  actual: string;
  passed: boolean;
}

export interface InvoicePreflightResult {
  passed: boolean;
  checks: InvoicePreflightCheck[];
  failedCheckIds: string[];
  canonicalHash: `0x${string}`;
}

export type SafeInvoiceIssueResult =
  | { kind: "PRECONDITION_FAILED"; preflight: InvoicePreflightResult }
  | { kind: "ALREADY_ISSUED"; preflight: InvoicePreflightResult }
  | {
      kind: "ISSUED";
      preflight: InvoicePreflightResult;
      invoice: InvoiceIssueResult;
    };

function exact(id: string, expected: string, actual: string): InvoicePreflightCheck {
  return { id, expected, actual, passed: expected === actual };
}

function address(id: string, expected: string, actual: string | null): InvoicePreflightCheck {
  const normalizedActual = actual?.toLowerCase() ?? "missing";
  return {
    id,
    expected: expected.toLowerCase(),
    actual: normalizedActual,
    passed: expected.length > 0 && normalizedActual === expected.toLowerCase(),
  };
}

function present(id: string, actual: string | null): InvoicePreflightCheck {
  return { id, expected: "present", actual: actual ? "present" : "missing", passed: !!actual };
}

export function validateInvoicePreflight(input: InvoicePreflightInput): InvoicePreflightResult {
  const buyerIdValid = isValidTaiwanBusinessId(input.buyerBusinessId);
  const sellerIdValid = input.sellerBusinessId
    ? isValidTaiwanBusinessId(input.sellerBusinessId)
    : false;
  const checks: InvoicePreflightCheck[] = [
    exact("PAYMENT_SETTLED", "SETTLED", input.paymentStatus ?? "missing"),
    exact("DELIVERY_DELIVERED", "DELIVERED", input.deliveryStatus ?? "missing"),
    present("DELIVERY_EVIDENCE_PRESENT", input.deliveryResponseHash),
    present("SETTLEMENT_TX_PRESENT", input.settlementTransactionHash),
    exact("QUOTE_REGISTRY_MATCH", input.registryQuoteAmountAtomic, input.quotedAmountAtomic),
    exact("ACTUAL_AMOUNT_MATCH", input.quotedAmountAtomic, input.actualAmountAtomic ?? "missing"),
    exact("SETTLED_AMOUNT_MATCH", input.quotedAmountAtomic, input.settledAmountAtomic ?? "missing"),
    address("PAYER_MATCH", input.buyerAddress, input.payerAddress),
    address("PURCHASE_PAYEE_MATCH", input.registryPayeeAddress, input.purchasePayeeAddress),
    address("SETTLED_PAYEE_MATCH", input.registryPayeeAddress, input.settledPayeeAddress),
    exact("REGISTRY_NETWORK_MATCH", input.registryNetwork, input.purchaseNetwork),
    exact("SETTLED_NETWORK_MATCH", input.purchaseNetwork, input.settledNetwork ?? "missing"),
    address("REGISTRY_TOKEN_MATCH", input.registryTokenAddress, input.purchaseTokenAddress),
    address("SETTLED_TOKEN_MATCH", input.purchaseTokenAddress, input.settledTokenAddress),
    exact("TOKEN_SYMBOL_MATCH", input.registryTokenSymbol, input.purchaseTokenSymbol),
    exact(
      "TOKEN_DECIMALS_MATCH",
      String(input.registryTokenDecimals),
      String(input.purchaseTokenDecimals),
    ),
    exact(
      "PAYMENT_ID_MATCH",
      input.purchasePaymentId,
      input.authorizationPaymentId ?? "missing",
    ),
    exact(
      "SELLER_SERVICE_INVOICE_CAPABLE",
      "true",
      String(input.serviceSupportsTwInvoice),
    ),
    exact("SELLER_INVOICE_CAPABILITY", "TW_B2B_DEMO", input.sellerInvoiceCapability),
    {
      id: "SELLER_INVOICE_PROVIDER_CONFIGURED",
      expected: "MOCK_OR_ECPAY_STAGE",
      actual: input.sellerInvoiceProvider,
      passed: input.sellerInvoiceProvider === "MOCK" || input.sellerInvoiceProvider === "ECPAY_STAGE",
    },
    {
      id: "BUYER_BUSINESS_ID_VALID",
      expected: "valid Taiwan business ID",
      actual: input.buyerBusinessId,
      passed: buyerIdValid,
    },
    exact("BUYER_BUSINESS_ID_MATCH", input.companyBusinessId, input.buyerBusinessId),
    {
      id: "SELLER_BUSINESS_ID_VALID",
      expected: "valid Taiwan business ID",
      actual: input.sellerBusinessId ?? "missing",
      passed: sellerIdValid,
    },
    {
      id: "INVOICE_ISSUABLE_STATE",
      expected: "PENDING_OR_FAILED_RETRYABLE_OR_ALREADY_ISSUED",
      actual: input.invoiceStatus,
      passed: ["PENDING", "FAILED_RETRYABLE", "ISSUED_DEMO", "ISSUED_STAGE"].includes(
        input.invoiceStatus,
      ),
    },
  ];
  const failedCheckIds = checks.filter(({ passed }) => !passed).map(({ id }) => id);
  const canonicalHash = hashCanonicalJson({
    schemaVersion: "1",
    kind: "INVOICE_PREFLIGHT",
    checks,
  });
  return { passed: failedCheckIds.length === 0, checks, failedCheckIds, canonicalHash };
}

function issueWithTimeout(
  adapter: InvoiceAdapter,
  issueInput: InvoiceIssueInput,
  timeoutMs: number,
): Promise<InvoiceIssueResult> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new RetryableInvoiceError(
        `Invoice adapter timed out after ${timeoutMs}ms`,
      );
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  return Promise.race([
    adapter.issue({ ...issueInput, signal: controller.signal }),
    timedOut,
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

export async function issueInvoiceSafely(input: {
  adapter: InvoiceAdapter;
  preflight: InvoicePreflightInput;
  issue: InvoiceIssueInput;
  timeoutMs?: number;
}): Promise<SafeInvoiceIssueResult> {
  const preflight = validateInvoicePreflight(input.preflight);
  if (!preflight.passed) return { kind: "PRECONDITION_FAILED", preflight };
  if (input.preflight.invoiceStatus === "ISSUED_DEMO" || input.preflight.invoiceStatus === "ISSUED_STAGE") {
    return { kind: "ALREADY_ISSUED", preflight };
  }
  const timeoutMs = input.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Invoice adapter timeout must be positive");
  }
  const invoice = await issueWithTimeout(input.adapter, input.issue, timeoutMs);
  return { kind: "ISSUED", preflight, invoice };
}
