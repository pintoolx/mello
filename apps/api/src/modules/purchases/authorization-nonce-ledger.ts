import type { Prisma, PrismaClient } from "@mello/db";
import { MelloError } from "@mello/shared";

export interface AuthorizationNonceReservation {
  purchaseId: string;
  paymentId: string;
  nonce: string;
  typedDataHash: string;
  createdAt: Date;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return typeof value === "string" ? [value] : [];
}

export function isAuthorizationNonceReuseError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error) || error.code !== "P2002") {
    return false;
  }
  const meta = "meta" in error && error.meta && typeof error.meta === "object"
    ? (error.meta as Record<string, unknown>)
    : {};
  const modelName = meta["modelName"];
  const targets = stringArray(meta["target"]);
  return (
    modelName === "PaymentAuthorizationNonce" ||
    targets.some(
      (target) =>
        target === "nonce" || target.includes("PaymentAuthorizationNonce_nonce"),
    )
  );
}

/**
 * Reserves a nonce before mutating the current authorization snapshot. The
 * callback shares this short transaction, so a unique violation rolls back all
 * current-evidence updates and makes A -> B -> A replay impossible.
 */
export async function withAuthorizationNonceReservation<T>(
  prisma: PrismaClient,
  input: AuthorizationNonceReservation,
  operation: (transaction: Prisma.TransactionClient, normalizedNonce: string) => Promise<T>,
): Promise<T> {
  const normalizedNonce = input.nonce.toLowerCase();
  try {
    return await prisma.$transaction(async (transaction) => {
      await transaction.paymentAuthorizationNonce.create({
        data: {
          purchaseId: input.purchaseId,
          paymentId: input.paymentId,
          nonce: normalizedNonce,
          typedDataHash: input.typedDataHash,
          createdAt: input.createdAt,
        },
      });
      return operation(transaction, normalizedNonce);
    });
  } catch (error: unknown) {
    if (isAuthorizationNonceReuseError(error)) {
      throw new MelloError(
        "ERC3009_NONCE_REUSED",
        "ERC-3009 authorization nonce has already been recorded",
        {
          statusCode: 409,
          retryable: false,
          details: { nonce: normalizedNonce },
        },
      );
    }
    throw error;
  }
}
