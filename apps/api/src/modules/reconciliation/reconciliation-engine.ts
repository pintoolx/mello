import { hashCanonicalJson } from "@mello/shared";

export type ReconciliationCheckId =
  | "SERVICE_AMOUNT_MATCH"
  | "PURCHASE_ACTUAL_AMOUNT_MATCH"
  | "AUTHORIZATION_AMOUNT_MATCH"
  | "SETTLED_AMOUNT_MATCH"
  | "PAYEE_MATCH"
  | "AUTHORIZATION_PAYEE_MATCH"
  | "SETTLED_PAYEE_MATCH"
  | "PAYER_MATCH"
  | "SETTLED_PAYER_MATCH"
  | "NETWORK_MATCH"
  | "AUTHORIZATION_NETWORK_MATCH"
  | "SETTLED_NETWORK_MATCH"
  | "TOKEN_MATCH"
  | "AUTHORIZATION_TOKEN_MATCH"
  | "SETTLED_TOKEN_MATCH"
  | "PAYMENT_ID_MATCH"
  | "AUTHORIZATION_PAYMENT_ID_MATCH"
  | "INVOICE_PAYMENT_ID_MATCH"
  | "PAYMENT_SETTLED"
  | "AUTHORIZATION_SETTLED"
  | "SETTLEMENT_TX_MATCH"
  | "INVOICE_SETTLEMENT_TX_MATCH"
  | "INVOICE_SOURCE_AMOUNT_MATCH"
  | "BUYER_ID_MATCH"
  | "SELLER_ID_MATCH"
  | "SELLER_BUSINESS_ID_MATCH"
  | "DELIVERY_PRESENT";

export interface ReconciliationCheck {
  id: ReconciliationCheckId;
  expected: string;
  actual: string;
  passed: boolean;
  required: boolean;
}

interface TokenEvidence {
  symbol: string;
  address: string;
  decimals: number;
}

export interface ReconciliationInput {
  /** Settlement scope validates financial evidence before receipt recovery. */
  scope?: "FINAL" | "SETTLEMENT";
  service: {
    amountAtomic: string;
    payee: string;
    network: string;
    token: TokenEvidence;
    sellerProfileId: string;
    sellerBusinessId: string | null;
  };
  purchase: {
    expectedAmountAtomic: string;
    actualAmountAtomic: string | null;
    payee: string;
    payer: string;
    network: string;
    token: TokenEvidence;
    paymentId: string;
  };
  authorization: null | {
    paymentId: string;
    amountAtomic: string;
    payee: string;
    payer: string;
    network: string;
    tokenAddress: string;
    status: string;
    settlementTransactionHash: string | null;
  };
  payment: {
    paymentId: string;
    status: string;
    transactionHash: string | null;
    amountAtomic: string;
    payee: string;
    payer: string;
    network: string;
    tokenAddress: string;
  };
  invoiceRequired: boolean;
  invoice: null | {
    sourceAmountAtomic: string;
    buyerBusinessId: string;
    sellerBusinessId: string;
    sellerProfileId: string;
    paymentId: string;
    paymentTransactionHash: string;
  };
  companyBusinessId: string;
  deliveryResponseHash: string | null;
}

export interface ReconciliationResult {
  status: "MATCHED" | "MISMATCH" | "PENDING";
  checks: ReconciliationCheck[];
  canonicalHash: `0x${string}`;
}

const INVOICE_CHECKS = new Set<ReconciliationCheckId>([
  "INVOICE_PAYMENT_ID_MATCH",
  "INVOICE_SETTLEMENT_TX_MATCH",
  "INVOICE_SOURCE_AMOUNT_MATCH",
  "BUYER_ID_MATCH",
  "SELLER_ID_MATCH",
  "SELLER_BUSINESS_ID_MATCH",
]);

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function check(
  id: ReconciliationCheckId,
  expected: string,
  actual: string,
  required = true,
  equal: (left: string, right: string) => boolean = (left, right) => left === right,
): ReconciliationCheck {
  return { id, expected, actual, required, passed: equal(expected, actual) };
}

function addressCheck(
  id: ReconciliationCheckId,
  expected: string,
  actual: string,
  required = true,
): ReconciliationCheck {
  return check(id, expected, actual, required, sameAddress);
}

function tokenSnapshot(token: TokenEvidence): string {
  return `${token.symbol}:${token.address.toLowerCase()}:${token.decimals}`;
}

function invoiceValue(input: ReconciliationInput, value: string | undefined): string {
  if (!input.invoiceRequired) return "NOT_REQUIRED";
  return value ?? "pending";
}

function buildChecks(input: ReconciliationInput): ReconciliationCheck[] {
  const settlementOnly = input.scope === "SETTLEMENT";
  const authorization = input.authorization;
  const invoice = input.invoice;
  const invoiceRequired = !settlementOnly && input.invoiceRequired;
  const finalOnly = !settlementOnly;
  const serviceToken = tokenSnapshot(input.service.token);
  const purchaseToken = tokenSnapshot(input.purchase.token);

  return [
    check("SERVICE_AMOUNT_MATCH", input.service.amountAtomic, input.purchase.expectedAmountAtomic),
    check(
      "PURCHASE_ACTUAL_AMOUNT_MATCH",
      input.purchase.expectedAmountAtomic,
      input.purchase.actualAmountAtomic ?? (settlementOnly ? input.payment.amountAtomic : "missing"),
    ),
    check(
      "AUTHORIZATION_AMOUNT_MATCH",
      input.purchase.expectedAmountAtomic,
      authorization?.amountAtomic ?? "missing",
    ),
    check("SETTLED_AMOUNT_MATCH", input.purchase.expectedAmountAtomic, input.payment.amountAtomic),
    addressCheck("PAYEE_MATCH", input.service.payee, input.purchase.payee),
    addressCheck(
      "AUTHORIZATION_PAYEE_MATCH",
      input.purchase.payee,
      authorization?.payee ?? "missing",
    ),
    addressCheck("SETTLED_PAYEE_MATCH", input.purchase.payee, input.payment.payee),
    addressCheck("PAYER_MATCH", input.purchase.payer, authorization?.payer ?? "missing"),
    addressCheck("SETTLED_PAYER_MATCH", input.purchase.payer, input.payment.payer),
    check("NETWORK_MATCH", input.service.network, input.purchase.network),
    check(
      "AUTHORIZATION_NETWORK_MATCH",
      input.purchase.network,
      authorization?.network ?? "missing",
    ),
    check("SETTLED_NETWORK_MATCH", input.purchase.network, input.payment.network),
    check("TOKEN_MATCH", serviceToken, purchaseToken),
    addressCheck(
      "AUTHORIZATION_TOKEN_MATCH",
      input.purchase.token.address,
      authorization?.tokenAddress ?? "missing",
    ),
    addressCheck("SETTLED_TOKEN_MATCH", input.purchase.token.address, input.payment.tokenAddress),
    check("PAYMENT_ID_MATCH", input.purchase.paymentId, input.payment.paymentId),
    check(
      "AUTHORIZATION_PAYMENT_ID_MATCH",
      input.purchase.paymentId,
      authorization?.paymentId ?? "missing",
    ),
    check(
      "PAYMENT_SETTLED",
      settlementOnly ? "SETTLEMENT_PENDING_OR_SETTLED" : "SETTLED",
      settlementOnly && ["SETTLEMENT_PENDING", "SETTLED"].includes(input.payment.status)
        ? "SETTLEMENT_PENDING_OR_SETTLED"
        : input.payment.status,
    ),
    check(
      "AUTHORIZATION_SETTLED",
      settlementOnly ? "SUBMITTED_OR_SETTLED" : "SETTLED",
      settlementOnly && ["SUBMITTED", "SETTLED"].includes(authorization?.status ?? "")
        ? "SUBMITTED_OR_SETTLED"
        : authorization?.status ?? "missing",
    ),
    check(
      "SETTLEMENT_TX_MATCH",
      input.payment.transactionHash ?? "missing",
      authorization?.settlementTransactionHash ??
        (settlementOnly ? input.payment.transactionHash ?? "missing" : "missing"),
      finalOnly,
    ),
    check(
      "INVOICE_PAYMENT_ID_MATCH",
      input.invoiceRequired ? input.purchase.paymentId : "NOT_REQUIRED",
      invoiceValue(input, invoice?.paymentId),
      invoiceRequired,
    ),
    check(
      "INVOICE_SETTLEMENT_TX_MATCH",
      input.invoiceRequired ? input.payment.transactionHash ?? "missing" : "NOT_REQUIRED",
      invoiceValue(input, invoice?.paymentTransactionHash),
      invoiceRequired,
    ),
    check(
      "INVOICE_SOURCE_AMOUNT_MATCH",
      input.invoiceRequired ? input.payment.amountAtomic : "NOT_REQUIRED",
      invoiceValue(input, invoice?.sourceAmountAtomic),
      invoiceRequired,
    ),
    check(
      "BUYER_ID_MATCH",
      input.invoiceRequired ? input.companyBusinessId : "NOT_REQUIRED",
      invoiceValue(input, invoice?.buyerBusinessId),
      invoiceRequired,
    ),
    check(
      "SELLER_ID_MATCH",
      input.invoiceRequired ? input.service.sellerProfileId : "NOT_REQUIRED",
      invoiceValue(input, invoice?.sellerProfileId),
      invoiceRequired,
    ),
    check(
      "SELLER_BUSINESS_ID_MATCH",
      input.invoiceRequired ? input.service.sellerBusinessId ?? "missing" : "NOT_REQUIRED",
      invoiceValue(input, invoice?.sellerBusinessId),
      invoiceRequired,
    ),
    check(
      "DELIVERY_PRESENT",
      finalOnly ? "present" : "NOT_APPLICABLE",
      finalOnly ? (input.deliveryResponseHash ? "present" : "missing") : "NOT_APPLICABLE",
      finalOnly,
    ),
  ];
}

export function reconcilePurchase(input: ReconciliationInput): ReconciliationResult {
  const checks = buildChecks(input);
  const invoicePending =
    input.scope !== "SETTLEMENT" && input.invoiceRequired && input.invoice === null;
  const nonInvoiceMismatch = checks.some(
    (item) => item.required && !item.passed && !INVOICE_CHECKS.has(item.id),
  );
  const status = nonInvoiceMismatch
    ? "MISMATCH"
    : invoicePending
      ? "PENDING"
      : checks.every((item) => !item.required || item.passed)
        ? "MATCHED"
        : "MISMATCH";
  return {
    status,
    checks,
    canonicalHash: hashCanonicalJson({
      schemaVersion: "2",
      scope: input.scope ?? "FINAL",
      status,
      checks,
    }),
  };
}
