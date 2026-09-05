import { sanitizedErrorForLog } from "@mello/shared";
import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";

export const LOGGER_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.x-demo-admin-token",
  "req.headers['payment-signature']",
  "privateKey",
  "*.privateKey",
  "EVM_PRIVATE_KEY",
  "*.EVM_PRIVATE_KEY",
  "CONTRACT_OPERATOR_PRIVATE_KEY",
  "*.CONTRACT_OPERATOR_PRIVATE_KEY",
  "OPENAI_API_KEY",
  "*.OPENAI_API_KEY",
  "SELLER_CONTEXT_HMAC_SECRET",
  "*.SELLER_CONTEXT_HMAC_SECRET",
  "ECPAY_STAGE_HASH_KEY",
  "*.ECPAY_STAGE_HASH_KEY",
  "ECPAY_STAGE_HASH_IV",
  "*.ECPAY_STAGE_HASH_IV",
  "signature",
  "*.signature",
  "paymentSignature",
  "*.paymentSignature",
] as const;

export function createLogger(destination?: DestinationStream): Logger {
  const options: LoggerOptions = {
    level: process.env["LOG_LEVEL"] ?? "info",
    // Service logs always carry the complete PRD correlation contract. Pino
    // merges per-call bindings over this null-safe baseline.
    base: {
      service: "mello-core-api",
      requestId: null,
      taskId: null,
      purchaseId: null,
      paymentId: null,
      sellerId: null,
      stage: null,
    },
    redact: {
      paths: [...LOGGER_REDACT_PATHS],
      censor: "[REDACTED]",
    },
    // Never let pino's default Error serializer copy a raw upstream message or
    // stack into service telemetry.
    serializers: { err: sanitizedErrorForLog },
  };
  return destination ? pino(options, destination) : pino(options);
}

export const logger = createLogger();
