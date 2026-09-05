export const MELLO_ERROR_CODES = [
  "AGENT_PARSE_FAILED",
  "NO_ELIGIBLE_SERVICE",
  "POLICY_REJECTED",
  "PAYMENTS_FROZEN",
  "APPROVAL_REQUIRED",
  "WALLET_INSUFFICIENT_FUNDS",
  "X402_REQUIREMENTS_INVALID",
  "X402_PAYMENT_FAILED",
  "ERC3009_AUTH_EXPIRED",
  "ERC3009_NONCE_REUSED",
  "ERC3009_TERMS_MISMATCH",
  "SERVICE_DELIVERY_FAILED",
  "INVOICE_ISSUE_FAILED",
  "RECONCILIATION_MISMATCH",
  "CONTRACT_ANCHOR_FAILED",
  "TASK_ALREADY_RUNNING",
  "IDEMPOTENCY_CONFLICT",
  "NOT_FOUND",
  "VALIDATION_ERROR",
  "INTERNAL_ERROR",
] as const;

export type MelloErrorCode = (typeof MELLO_ERROR_CODES)[number];

export class MelloError extends Error {
  readonly code: MelloErrorCode;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    code: MelloErrorCode,
    message: string,
    options: { statusCode?: number; retryable?: boolean; details?: unknown } = {},
  ) {
    super(message);
    this.name = "MelloError";
    this.code = code;
    this.statusCode = options.statusCode ?? 400;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}
