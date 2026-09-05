import type { RequestHandler } from "express";

// A small single-replica demo circuit breaker, not a distributed abuse/WAF system.
// Global counters cannot be bypassed with forged proxy/IP headers and use O(1) memory.
export function createPublicRequestLimits(options: {
  now?: () => number; requestsPerWindow?: number; paidAttemptsPerWindow?: number;
  concurrentRequests?: number;
} = {}): RequestHandler {
  const now = options.now ?? Date.now;
  const requestLimit = options.requestsPerWindow ?? 120;
  const paidLimit = options.paidAttemptsPerWindow ?? 12;
  const concurrentLimit = options.concurrentRequests ?? 4;
  const windowMs = 60_000;
  let resetAt = now() + windowMs;
  let requests = 0;
  let paidAttempts = 0;
  let active = 0;
  return (request, response, next) => {
    const time = now();
    if (time >= resetAt) { requests = 0; paidAttempts = 0; resetAt = time + windowMs; }
    const paid = Boolean(request.get("payment-signature"));
    if (requests >= requestLimit || (paid && paidAttempts >= paidLimit)) {
      response.set("Retry-After", String(Math.max(1, Math.ceil((resetAt - time) / 1000))));
      response.set("Cache-Control", "no-store").status(429).json({ error: {
        code: "PUBLIC_SELLER_RATE_LIMITED", message: "Public demo request limit reached; retry later without creating a new payment.", retryable: true,
      } });
      return;
    }
    if (active >= concurrentLimit) {
      response.set("Retry-After", "1").set("Cache-Control", "no-store").status(503).json({ error: {
        code: "PUBLIC_SELLER_BUSY", message: "Public demo capacity is busy; retain the same payment identifier when retrying.", retryable: true,
      } });
      return;
    }
    requests++;
    if (paid) paidAttempts++;
    active++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active--;
      response.off("finish", release);
      response.off("close", release);
    };
    response.once("finish", release);
    response.once("close", release);
    next();
  };
}
