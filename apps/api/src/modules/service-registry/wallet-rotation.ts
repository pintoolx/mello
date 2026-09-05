import assert from "node:assert/strict";
import type { Prisma, PrismaClient } from "@mello/db";
import { BASE_SEPOLIA_USDC, MELLO_NETWORK, USDC_DECIMALS } from "@mello/shared";
import { getAddress, isAddress, zeroAddress } from "viem";
import { appendAuditEvent } from "../audit/index.js";
import { acquireWorkflowQueueExclusiveLock } from "../workflow-jobs/queue-lock.js";
import { publicBindingTargets } from "./deployment-sync.js";

const MAX_PRESERVED_DRAFTS = 100;
const DRAFT_SAFETY_SELECT = {
  status: true, purchase: { select: { id: true } }, runStartedAt: true, completedAt: true,
  intent: true, candidates: true, decisionSummary: true, errorCode: true, errorMessage: true,
  usedFallbackParser: true,
  control: { select: {
    expectedPayTo: true, pendingTerms: true, approvedTermsHash: true,
    approvedAt: true, paymentReleaseGrantedAt: true,
  } },
} satisfies Prisma.TaskSelect;

export type SellerRotationDraft = Prisma.TaskGetPayload<{ select: typeof DRAFT_SAFETY_SELECT }>;

/** A request identity or initial approval limit is not an approved or started purchase. */
export function assertPristineSellerRotationDrafts(tasks: readonly SellerRotationDraft[]): void {
  assert.ok(tasks.length <= MAX_PRESERVED_DRAFTS,
    "Too many existing drafts for a bounded seller wallet rotation review");
  for (const task of tasks) {
    assert.ok(task.status === "CREATED" && task.purchase === null && task.usedFallbackParser === false &&
      [task.runStartedAt, task.completedAt, task.intent, task.candidates, task.decisionSummary,
        task.errorCode, task.errorMessage].every((value) => value === null) &&
      (task.control === null || [task.control.expectedPayTo, task.control.pendingTerms,
        task.control.approvedTermsHash, task.control.approvedAt, task.control.paymentReleaseGrantedAt]
        .every((value) => value === null)),
    "Existing work must finish before rotating wallets; only pristine CREATED drafts may remain");
  }
}

function requiredAddress(env: NodeJS.ProcessEnv, key: string) {
  const value = env[key];
  assert.ok(value && isAddress(value, { strict: true }) && value.toLowerCase() !== zeroAddress,
    `${key} must be an explicit, nonzero EVM address with a valid checksum`);
  return getAddress(value);
}

/** Public configuration only: this operation never reads or needs private keys. */
export function sellerWalletRotationTargets(env: NodeJS.ProcessEnv) {
  const targets = publicBindingTargets(env).map(({ id, endpoint }, index) => {
    const role = index === 0 ? "A" : "B";
    return {
      id, endpoint, sellerId: `seller-${role.toLowerCase()}`,
      previousPayTo: requiredAddress(env, `SELLER_${role}_PREVIOUS_PAY_TO`),
      payTo: requiredAddress(env, `SELLER_${role}_PAY_TO`),
      priceAtomic: index === 0 ? "40000" : "50000",
      supportsTwInvoice: index !== 0,
      invoiceCapability: index === 0 ? "NONE" : "TW_B2B_DEMO",
      invoiceProvider: index === 0 ? "NONE" : "MOCK",
    };
  });
  assert.equal(new Set(targets.flatMap(({ previousPayTo, payTo }) =>
    [previousPayTo.toLowerCase(), payTo.toLowerCase()])).size, 4,
  "Both replacement wallets must be distinct and must not reuse either previous wallet");
  assert.equal(new Set(targets.map(({ endpoint }) => endpoint)).size, 2,
    "Seller endpoints must remain distinct");
  return targets;
}

export async function rotateSellerWallets(prisma: PrismaClient, env: NodeJS.ProcessEnv) {
  if (env["MELLO_ROTATE_SELLER_WALLETS"] !== "true") return { skipped: true, updated: [] };
  const targets = sellerWalletRotationTargets(env);
  return prisma.$transaction(async (tx) => {
    // Fence enqueue/claim before checking for active work. Take this lock first,
    // then preserve service review -> payment release lock order. Do not perform
    // network calls while holding these transaction-scoped locks.
    await acquireWorkflowQueueExclusiveLock(tx);
    for (const { id } of targets) {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`mello:verification:${id}`}, 0)) IS NULL AS acquired`;
    }
    await tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${"mello:payment-release-gate"}, 0)) IS NULL AS acquired`;
    assert.equal((await tx.paymentControl.findUnique({ where: { id: "global" } }))?.paymentsFrozen, true,
      "Freeze new payments before rotating seller wallets");
    const activeJobs = await tx.workflowJob.count({ where: { status: { in: ["PENDING", "RUNNING", "FAILED_RETRYABLE"] } } });
    const activeTasks = await tx.task.findMany({
      where: { status: { notIn: ["COMPLETED", "REJECTED", "FAILED"] } },
      select: DRAFT_SAFETY_SELECT, orderBy: { id: "asc" }, take: MAX_PRESERVED_DRAFTS + 1,
    });
    const activePurchases = await tx.purchase.count({ where: { status: { notIn: ["COMPLETED", "FAILED"] } } });
    const uncertainPayments = await tx.payment.count({ where: { status: { in: ["AUTHORIZED", "SETTLEMENT_PENDING"] } } });
    const activeSellerPayments = await tx.sellerPaymentCache.count({ where: {
      sellerId: { in: targets.map(({ sellerId }) => sellerId) }, status: { in: ["PROCESSING", "SETTLING"] },
    } });
    assert.equal(activeJobs + activePurchases + uncertainPayments + activeSellerPayments, 0,
      "Existing work and seller settlements must finish before rotating wallets");
    // Do not delete or rewrite untouched UI drafts. Their original request keys,
    // limits, prompts and timestamps remain available for a later explicit run.
    assertPristineSellerRotationDrafts(activeTasks);

    // Validate the complete reviewed batch before changing any seller. A seller
    // shared by an additional service is outside this operation's lock scope.
    const checked = [];
    for (const target of targets) {
      const service = await tx.service.findUniqueOrThrow({ where: { id: target.id }, include: { seller: true } });
      assert.equal(service.sellerId, target.sellerId, "Unexpected service seller binding");
      assert.equal(await tx.service.count({ where: { sellerId: target.sellerId } }), 1,
        "Additional services sharing a seller require a separate reviewed rotation");
      assert.equal(service.seller.status, "ACTIVE", "Only active demo sellers can be rotated");
      assert.equal(service.active, true, "Only active demo services can be rotated");
      assert.equal(service.category, "credit_report", "Unexpected service category");
      assert.equal(service.method, "POST", "Unexpected service method");
      assert.equal(service.endpoint, target.endpoint, "Unexpected public service endpoint");
      assert.equal(service.priceAtomic, target.priceAtomic, "Unexpected service price");
      assert.equal(service.network, MELLO_NETWORK, "Wallet rotation is limited to Base Sepolia");
      assert.equal(service.tokenSymbol, "USDC", "Wallet rotation is limited to USDC");
      assert.equal(service.tokenAddress.toLowerCase(), BASE_SEPOLIA_USDC.toLowerCase(), "Unexpected USDC asset");
      assert.equal(service.tokenDecimals, USDC_DECIMALS, "Unexpected USDC decimals");
      assert.equal(service.supportsTwInvoice, target.supportsTwInvoice, "Unexpected invoice support");
      assert.equal(service.seller.invoiceCapability, target.invoiceCapability, "Unexpected invoice capability");
      assert.equal(service.seller.invoiceProvider, target.invoiceProvider, "Unexpected invoice provider");
      assert.ok([target.previousPayTo, target.payTo].some((value) =>
        value.toLowerCase() === service.seller.payToAddress.toLowerCase()),
      "Unexpected existing seller wallet requires a separate reviewed rotation");
      checked.push({ target, seller: service.seller });
    }

    const updated: { serviceId: string; sellerId: string; previousPayTo: string; payTo: string }[] = [];
    for (const { target, seller } of checked) {
      if (seller.payToAddress.toLowerCase() === target.payTo.toLowerCase()) continue;
      const changed = await tx.seller.updateMany({
        where: { id: target.sellerId, payToAddress: seller.payToAddress }, data: { payToAddress: target.payTo },
      });
      assert.equal(changed.count, 1, "Seller wallet changed concurrently; no rotation was committed");
      await appendAuditEvent(tx, {
        aggregateType: "SERVICE", aggregateId: target.id, sellerId: target.sellerId,
        actorType: "ADMIN", eventType: "SERVICE_BINDING_UPDATED", payload: {
          operation: "APPROVED_SELLER_WALLET_ROTATION", previousPayTo: seller.payToAddress,
          payTo: target.payTo, endpoint: target.endpoint, priceAtomic: target.priceAtomic,
          network: MELLO_NETWORK, tokenAddress: BASE_SEPOLIA_USDC,
          automaticCertification: false, historicalPurchasesChanged: false,
        },
      });
      updated.push({ serviceId: target.id, sellerId: target.sellerId, previousPayTo: seller.payToAddress, payTo: target.payTo });
    }
    // Existing verification records intentionally remain bound to the old wallet;
    // verificationSummary will report BINDING_CHANGED until a separate review.
    return { skipped: false, updated };
  });
}
