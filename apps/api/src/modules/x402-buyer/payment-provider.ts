import {
  MelloError,
  type Erc3009AuthorizationRecord,
  type MelloErrorCode,
} from "@mello/shared";
import { z } from "zod";

export const PaymentSettlementReportSchema = z
  .object({
    reportId: z.string().min(1),
    provider: z.string().min(1),
    targetCompanyName: z.string().min(1),
    riskScore: z.number().min(0).max(100),
    riskLevel: z.enum(["LOW", "MEDIUM", "HIGH"]),
    summary: z.string().min(1),
    generatedAt: z.iso.datetime(),
  })
  .passthrough();

export type PaymentSettlementReport = z.infer<typeof PaymentSettlementReportSchema>;

export interface PreparePaymentInput {
  taskId: string;
  requestId?: string | undefined;
  purchaseId: string;
  paymentId: string;
  sellerId: string;
  endpoint: string;
  targetCompanyName: string;
  purchaseContextToken: string;
  requiresTwInvoice: boolean;
  network: string;
  tokenAddress: `0x${string}`;
  payerAddress: `0x${string}`;
  payToAddress: `0x${string}`;
  amountAtomic: string;
  authorizationTtlSeconds: number;
  /**
   * Absolute Unix timestamp (seconds) after applying the purchase-mandate
   * safety margin. An ERC-3009 authorization must never outlive this bound.
   */
  maximumValidBefore: bigint;
  /** Optional P0 Seller declaration checked against the Core configuration. */
  expectedFacilitatorUrl?: string;
  /**
   * Invoked with the live 402 requirements before any ERC-3009 signature is
   * created. The workflow uses this boundary to apply and durably record the
   * enterprise policy decision. Throwing must abort payment creation.
   */
  onLivePaymentTerms?: ((terms: ValidatedPaymentTerms) => Promise<void>) | undefined;
}

export interface ValidatedPaymentTerms {
  scheme: "exact";
  network: string;
  tokenAddress: `0x${string}`;
  tokenSymbol: "USDC";
  tokenDecimals: 6;
  payToAddress: `0x${string}`;
  amountAtomic: string;
  transferMethod: "eip3009";
  facilitatorUrl: string | null;
}

export const AUTHORIZATION_MANDATE_EXPIRY_SAFETY_SECONDS = 30n;

export function maximumAuthorizationValidBefore(mandateExpiresAt: Date): bigint {
  const expiresAtMs = mandateExpiresAt.getTime();
  if (!Number.isFinite(expiresAtMs)) {
    throw new MelloError("X402_REQUIREMENTS_INVALID", "Purchase mandate expiry is invalid");
  }
  return (
    BigInt(Math.floor(expiresAtMs / 1_000)) -
    AUTHORIZATION_MANDATE_EXPIRY_SAFETY_SECONDS
  );
}

export function assertAuthorizationTimeoutWithinPolicy(
  input: Pick<
    PreparePaymentInput,
    "authorizationTtlSeconds" | "maximumValidBefore"
  >,
  sellerTimeoutSeconds: number,
  nowSeconds: bigint,
): void {
  if (
    !Number.isInteger(input.authorizationTtlSeconds) ||
    input.authorizationTtlSeconds <= 0 ||
    !Number.isInteger(sellerTimeoutSeconds) ||
    sellerTimeoutSeconds <= 0
  ) {
    throw new MelloError(
      "X402_REQUIREMENTS_INVALID",
      "Seller authorization timeout is invalid",
    );
  }

  const sellerValidBefore = nowSeconds + BigInt(sellerTimeoutSeconds);
  const ttlValidBefore = nowSeconds + BigInt(input.authorizationTtlSeconds);
  if (
    input.maximumValidBefore <= nowSeconds ||
    sellerValidBefore > ttlValidBefore ||
    sellerValidBefore > input.maximumValidBefore
  ) {
    throw new MelloError(
      "X402_REQUIREMENTS_INVALID",
      "Seller authorization timeout exceeds the approved TTL or purchase mandate",
    );
  }
}

export interface PaymentSettlement {
  paymentId: string;
  transactionHash: `0x${string}`;
  payerAddress: `0x${string}`;
  payeeAddress: `0x${string}`;
  amountAtomic: string;
  network: string;
  tokenAddress: `0x${string}`;
  /** Chain id observed from the RPC while independently verifying the receipt. */
  verifiedChainId?: number | undefined;
  paymentResponse: unknown;
  report: PaymentSettlementReport;
}

export type SettledPaymentEvidence = Omit<PaymentSettlement, "report">;

/**
 * Evidence returned by the Seller before Mello has independently confirmed the
 * receipt. It is safe to retain for operator reconciliation, but must not be
 * promoted to SETTLED on its own.
 */
export type PendingSettlementEvidence = SettledPaymentEvidence & {
  /** Schema-validated response held internally until the receipt is confirmed. */
  report?: PaymentSettlementReport | undefined;
};

export interface SettlementVerificationEvidence {
  verifiedChainId: number;
}

export class PendingSettlementVerificationError extends MelloError {
  readonly evidence: PendingSettlementEvidence;

  constructor(message: string, evidence: PendingSettlementEvidence, cause: unknown) {
    super("X402_PAYMENT_FAILED", message, {
      retryable: cause instanceof MelloError ? cause.retryable : true,
      details: {
        transactionHash: evidence.transactionHash,
        verificationError: "Settlement receipt verification failed",
      },
    });
    this.name = "PendingSettlementVerificationError";
    this.evidence = evidence;
  }
}

export interface PaymentSubmissionHooks {
  /**
   * Awaited immediately before the real x402 provider releases the signed paid
   * request. Persisting the audit boundary here keeps a failed audit write from
   * accidentally submitting a payment.
   */
  onBeforePaidRequest?: (() => Promise<void>) | undefined;
  /**
   * Awaited only after the provider has irreversibly released or started the
   * signed paid request. Failures here therefore represent an ambiguous
   * submission and must never trigger an automatic resubmission.
   */
  onPaidRequestReleased?: (() => Promise<void>) | undefined;
}

/**
 * The facilitator has already settled the token transfer, but the paid
 * resource response cannot be accepted. Callers must persist `settlement`
 * before moving the delivery to an operator-visible failure state.
 */
export class SettledPaymentDeliveryError extends MelloError {
  readonly settlement: SettledPaymentEvidence;

  constructor(
    code: Extract<MelloErrorCode, "SERVICE_DELIVERY_FAILED" | "X402_PAYMENT_FAILED">,
    message: string,
    settlement: SettledPaymentEvidence,
    options: { retryable?: boolean; details?: unknown } = {},
  ) {
    super(code, message, options);
    this.name = "SettledPaymentDeliveryError";
    this.settlement = settlement;
  }
}

export interface PreparedPayment {
  authorization: Erc3009AuthorizationRecord;
  authorizationHash: `0x${string}`;
  paymentRequired: unknown;
  /** Terms taken from the live 402 response after protocol-level validation. */
  validatedTerms: ValidatedPaymentTerms;
  /** Rejects the SDK's paused paid request without releasing signature material. */
  cancel(reason?: string): void;
  submit(hooks?: PaymentSubmissionHooks): Promise<PaymentSettlement>;
}

export interface PaymentProvider {
  readonly mode: "mock" | "x402";
  getAddress(): Promise<`0x${string}`>;
  prepare(input: PreparePaymentInput): Promise<PreparedPayment>;
  /**
   * Read-only, independent receipt verification for a previously submitted
   * candidate transaction. This must never prepare, sign, or submit payment.
   */
  verifySettlement?(
    evidence: PendingSettlementEvidence,
  ): Promise<SettlementVerificationEvidence>;
}
