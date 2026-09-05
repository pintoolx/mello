export const PAYMENT_REQUIRED_HEADER = "payment-required" as const;
export const PAYMENT_SIGNATURE_HEADER = "payment-signature" as const;
export const PAYMENT_RESPONSE_HEADER = "payment-response" as const;

export const MOCK_PAYMENT_HEADER = "x-mello-mock-payment" as const;
export const MOCK_PAYMENT_HEADER_VALUE = "settled" as const;
export const MOCK_PAYMENT_ID_HEADER = "x-mello-payment-id" as const;
export const PAYMENT_MODE_HEADER = "x-mello-payment-mode" as const;
export const IDEMPOTENCY_STATUS_HEADER = "x-mello-idempotency" as const;

export const EXPOSED_PAYMENT_HEADERS = [
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_MODE_HEADER,
  IDEMPOTENCY_STATUS_HEADER,
].join(", ");
