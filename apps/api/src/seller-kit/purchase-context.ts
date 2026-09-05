import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const PurchaseContextPayloadSchema = z
  .object({
    purchaseId: z.uuid(),
    buyerProfileId: z.uuid(),
    sellerId: z.enum(["seller-a", "seller-b"]),
    nonce: z.string().regex(/^[a-f0-9]{32}$/),
    exp: z.number().int().positive(),
  })
  .strict();

export type PurchaseContextPayload = z.infer<
  typeof PurchaseContextPayloadSchema
>;

function signatureFor(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

/**
 * Creates a token byte-for-byte compatible with the Core API token codec.
 * This is exported so callers and tests can exercise the trust boundary without
 * duplicating the wire format.
 */
export function createPurchaseContextToken(
  input: Omit<PurchaseContextPayload, "nonce" | "exp">,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): string {
  const payload = PurchaseContextPayloadSchema.parse({
    ...input,
    nonce: randomBytes(16).toString("hex"),
    exp: nowSeconds + 600,
  });
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `${encodedPayload}.${signatureFor(encodedPayload, secret)}`;
}

/** Verifies signature, payload shape, UUID purchase identity, and expiry. */
export function verifyPurchaseContextToken(
  token: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): PurchaseContextPayload {
  const [encodedPayload, providedSignature, unexpected] = token.split(".");
  if (!encodedPayload || !providedSignature || unexpected) {
    throw new Error("Malformed context token");
  }

  const expectedSignature = signatureFor(encodedPayload, secret);
  const provided = Buffer.from(providedSignature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    throw new Error("Invalid context token signature");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as unknown;
  } catch {
    throw new Error("Malformed context token payload");
  }
  const payload = PurchaseContextPayloadSchema.parse(decoded);
  if (payload.exp <= nowSeconds) throw new Error("Context token expired");
  return payload;
}
