import { Prisma, type PrismaClient } from "@mello/db";
import { taipeiDayBounds } from "./day-boundary.js";

type TransactionClient = Prisma.TransactionClient;

export interface DailySpendReservation {
  reservedAtomic: string;
  transaction: TransactionClient;
}

/**
 * Serializes policy reservations per company.
 *
 * The transaction-scoped advisory lock is intentionally acquired before the
 * reservation query. Keeping the key stable across day boundaries ensures a
 * workflow beginning just after Asia/Taipei midnight observes an unresolved
 * Purchase committed by a workflow that began just before midnight.
 */
export async function withDailySpendReservationLock<T>(
  prisma: PrismaClient,
  input: { buyerProfileId: string; now: Date },
  operation: (reservation: DailySpendReservation) => Promise<T>,
): Promise<T> {
  const bounds = taipeiDayBounds(input.now);
  const lockKey = input.buyerProfileId;

  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
    );

    const purchases = await transaction.purchase.findMany({
      where: {
        buyerProfileId: input.buyerProfileId,
        OR: [
          {
            payment: {
              is: {
                status: "SETTLED",
                settledAt: { gte: bounds.start, lt: bounds.end },
              },
            },
          },
          {
            // Once payment can still settle, the exposure carries forward
            // across calendar days until settlement or conclusive failure.
            payment: {
              is: { status: { in: ["AUTHORIZED", "SETTLEMENT_PENDING"] } },
            },
          },
          {
            // A retryable pre-payment Purchase still owns its reservation. A
            // terminal FAILED Purchase or FAILED payment releases it. This
            // risk also carries forward when the Purchase began before today.
            status: { not: "FAILED" },
            payment: { is: { status: "NOT_STARTED" } },
          },
        ],
      },
      select: {
        expectedAmountAtomic: true,
        actualAmountAtomic: true,
        payment: { select: { status: true, amountAtomic: true } },
      },
    });

    const reservedAtomic = purchases
      .reduce((total, purchase) => {
        const amount =
          purchase.payment?.status === "SETTLED"
            ? (purchase.payment.amountAtomic ??
              purchase.actualAmountAtomic ??
              purchase.expectedAmountAtomic)
            : purchase.expectedAmountAtomic;
        return total + BigInt(amount);
      }, 0n)
      .toString();

    return operation({ reservedAtomic, transaction });
  });
}
