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
export type PurchaseContextPayload = z.infer<typeof PurchaseContextPayloadSchema>;

function signatureFor(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

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
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${signatureFor(encodedPayload, secret)}`;
}

export function verifyPurchaseContextToken(
  token: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): PurchaseContextPayload {
  const [encodedPayload, providedSignature, unexpected] = token.split(".");
  if (!encodedPayload || !providedSignature || unexpected) throw new Error("Malformed context token");
  const expectedSignature = signatureFor(encodedPayload, secret);
  const provided = Buffer.from(providedSignature);
  const expected = Buffer.from(expectedSignature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new Error("Invalid context token signature");
  }
  const payload = PurchaseContextPayloadSchema.parse(
    JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")),
  );
  if (payload.exp <= nowSeconds) throw new Error("Context token expired");
  return payload;
}
