import { redactSensitiveText } from "@mello/shared";

export interface SellerLogContext {
  requestId?: string | null | undefined;
  taskId?: string | null | undefined;
  purchaseId?: string | null | undefined;
  paymentId?: string | null | undefined;
  sellerId?: string | null | undefined;
  stage?: string | null | undefined;
}

export interface SellerServiceLogger {
  info(context: SellerLogContext, message: string, details?: unknown): void;
  error(context: SellerLogContext, message: string, details?: unknown): void;
}

export type SellerLogDestination = (line: string) => void;

const SENSITIVE_KEY =
  /(?:authorization|cookie|credential|hash[_-]?iv|hash[_-]?key|hmac|password|private[_-]?key|secret|signature|token)/iu;

function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(item, seen);
  }
  return result;
}

export function createSellerServiceLogger(
  sellerId: string,
  // This destination is for long-running service telemetry. CLI scripts may
  // still write human-oriented progress and errors directly to stderr.
  destination: SellerLogDestination = (line) => process.stderr.write(line),
  now: () => Date = () => new Date(),
): SellerServiceLogger {
  const write = (
    level: "info" | "error",
    context: SellerLogContext,
    message: string,
    details?: unknown,
  ): void => {
    const entry = {
      level,
      time: now().toISOString(),
      service: "mello-seller",
      requestId: context.requestId ?? null,
      taskId: context.taskId ?? null,
      purchaseId: context.purchaseId ?? null,
      paymentId: context.paymentId ?? null,
      sellerId: context.sellerId ?? sellerId,
      stage: context.stage ?? null,
      message: redactSensitiveText(message),
      ...(details === undefined ? {} : { details: redact(details) }),
    };
    destination(`${JSON.stringify(entry)}\n`);
  };
  return {
    info: (context, message, details) => write("info", context, message, details),
    error: (context, message, details) =>
      write("error", context, message, details),
  };
}
