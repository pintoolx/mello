const REDACTED = "[REDACTED]";

const URL_CREDENTIALS =
  /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu;
const URL_SECRET_QUERY =
  /([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|password|private[_-]?key|secret|token)=)[^&#\s]+/giu;
const URL_SECRET_PATH =
  /(\/(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|private[_-]?key|secret|token)\/)[^/?#\s]+/giu;
const HOSTED_RPC_KEY_PATH =
  /((?:https?:\/\/)?[^/\s]*(?:alchemy\.com\/v2|infura\.io\/v3|qui(?:c)?knode\.pro)\/)[^/?#\s]+/giu;
const GENERIC_LONG_URL_PATH_SEGMENT =
  /((?:https?:\/\/)[^?\s#]*\/)[A-Za-z0-9._~-]{16,}(?=[/?#\s]|$)/giu;
const GENERIC_LONG_URL_QUERY_VALUE =
  /([?&][^=&#\s]+=)[^&#\s]{12,}/giu;
const NAMED_SECRET =
  /\b(DATABASE_URL|DIRECT_DATABASE_URL|OPENAI_API_KEY|EVM_PRIVATE_KEY|CONTRACT_OPERATOR_PRIVATE_KEY|SELLER_CONTEXT_HMAC_SECRET|ECPAY_STAGE_HASH_KEY|ECPAY_STAGE_HASH_IV)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/giu;
const BEARER_CREDENTIAL = /\bBearer\s+[^\s,;]+/giu;
const OPENAI_STYLE_KEY = /\bsk-[A-Za-z0-9_-]+\b/gu;
const PRIVATE_KEY_LIKE_HEX = /\b0x[a-fA-F0-9]{64}\b/gu;

/**
 * Removes common credential shapes from untrusted exception text. This is for
 * error/log boundaries, not business data: a 32-byte hex string is treated as
 * secret-like even though the same shape can also represent a transaction hash.
 */
export function redactSensitiveText(value: string): string {
  return value
    .replace(URL_CREDENTIALS, `$1${REDACTED}@`)
    .replace(URL_SECRET_QUERY, `$1${REDACTED}`)
    .replace(URL_SECRET_PATH, `$1${REDACTED}`)
    .replace(HOSTED_RPC_KEY_PATH, `$1${REDACTED}`)
    .replace(GENERIC_LONG_URL_PATH_SEGMENT, `$1${REDACTED}`)
    .replace(GENERIC_LONG_URL_QUERY_VALUE, `$1${REDACTED}`)
    .replace(NAMED_SECRET, `$1=${REDACTED}`)
    .replace(BEARER_CREDENTIAL, REDACTED)
    .replace(OPENAI_STYLE_KEY, REDACTED)
    .replace(PRIVATE_KEY_LIKE_HEX, REDACTED);
}

/** Recursively sanitizes untrusted error metadata before returning it to a client. */
export function redactSensitiveValue(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValue(item, seen));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      redactSensitiveValue(item, seen),
    ]),
  );
}

export function sanitizedErrorMessage(
  error: unknown,
  fallback: string,
  maxLength = 2_000,
): string {
  const raw = error instanceof Error ? error.message : fallback;
  const sanitized = redactSensitiveText(raw).trim();
  return (sanitized || fallback).slice(0, maxLength);
}

export interface SanitizedErrorLog {
  type: string;
  message: string;
  stack?: string | undefined;
  code?: string | undefined;
}

/** Keeps diagnostics useful while ensuring pino never serializes a raw Error. */
export function sanitizedErrorForLog(error: unknown): SanitizedErrorLog {
  if (!(error instanceof Error)) {
    return { type: "UnknownError", message: "Unknown error" };
  }
  const possibleCode = (error as Error & { code?: unknown }).code;
  return {
    type: error.name || "Error",
    message: sanitizedErrorMessage(error, "Unexpected internal error"),
    ...(error.stack ? { stack: redactSensitiveText(error.stack) } : {}),
    ...(typeof possibleCode === "string"
      ? { code: redactSensitiveText(possibleCode) }
      : {}),
  };
}
