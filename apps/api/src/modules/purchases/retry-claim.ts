import type { Prisma } from "@mello/db";

export interface RetryClaimInput {
  claimId: string;
  claimedAt: Date;
  staleBefore: Date;
}

export async function claimInvoiceRetry(
  transaction: Prisma.TransactionClient,
  invoiceId: string,
  input: RetryClaimInput,
): Promise<boolean> {
  const result = await transaction.invoice.updateMany({
    where: {
      id: invoiceId,
      status: "FAILED_RETRYABLE",
      OR: [
        { retryClaimId: null },
        { retryClaimedAt: { lt: input.staleBefore } },
      ],
    },
    data: { retryClaimId: input.claimId, retryClaimedAt: input.claimedAt },
  });
  return result.count === 1;
}

export async function claimAnchorRetry(
  transaction: Prisma.TransactionClient,
  anchorId: string,
  input: RetryClaimInput,
): Promise<boolean> {
  const result = await transaction.onchainAnchor.updateMany({
    where: {
      id: anchorId,
      status: "FAILED_RETRYABLE",
      OR: [
        { retryClaimId: null },
        { retryClaimedAt: { lt: input.staleBefore } },
      ],
    },
    data: { retryClaimId: input.claimId, retryClaimedAt: input.claimedAt },
  });
  return result.count === 1;
}
