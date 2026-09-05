import { randomUUID } from "node:crypto";
import type { AuditAnchorClient } from "@mello/contracts-client";
import { prisma } from "@mello/db";
import { BASE_SEPOLIA_USDC, DEMO_COMPANY_ID, MELLO_NETWORK } from "@mello/shared";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../config.js";
import {
  MockInvoiceAdapter,
  RetryableInvoiceError,
  type InvoiceAdapter,
} from "../invoices/index.js";
import type { PaymentProvider } from "../x402-buyer/index.js";
import { withDailySpendReservationLock } from "./daily-spend-reservation.js";
import { PurchaseWorkflow } from "./purchase-workflow.js";
import { claimAnchorRetry, claimInvoiceRetry } from "./retry-claim.js";

const RUN_INTEGRATION_TESTS =
  process.env["RUN_INTEGRATION_TESTS"] === "true" ||
  process.env["RUN_PURCHASE_CONCURRENCY_INTEGRATION_TESTS"] === "true";

const BUYER = "0x9999999999999999999999999999999999999999";
const SELLER_ADDRESS = "0x2222222222222222222222222222222222222222";
const HASH = `0x${"1".repeat(64)}`;
const NOW = new Date("2030-01-01T04:00:00.000Z");
const RECOVERY_REPORT = {
  reportId: "report-concurrent-recovery",
  provider: "concurrency-seller-placeholder",
  targetCompanyName: "Example Co.",
  riskScore: 20,
  riskLevel: "LOW" as const,
  summary: "Low risk",
  generatedAt: NOW.toISOString(),
};

const fixtureIds = {
  companies: [] as string[],
  sellers: [] as string[],
  services: [] as string[],
  tasks: [] as string[],
  purchases: [] as string[],
};

async function createCatalogFixture(): Promise<{
  buyerProfileId: string;
  sellerId: string;
  serviceId: string;
  taskIds: [string, string];
}> {
  const buyerProfileId = DEMO_COMPANY_ID;
  const sellerId = `concurrency-seller-${randomUUID()}`;
  const serviceId = `concurrency-service-${randomUUID()}`;
  const taskIds: [string, string] = [randomUUID(), randomUUID()];
  fixtureIds.sellers.push(sellerId);
  fixtureIds.services.push(serviceId);
  fixtureIds.tasks.push(...taskIds);

  await prisma.seller.create({
    data: {
      id: sellerId,
      legalName: "Concurrency Test Seller",
      businessId: "24536806",
      payToAddress: SELLER_ADDRESS,
      invoiceCapability: "TW_B2B_DEMO",
      invoiceProvider: "MOCK",
    },
  });
  await prisma.service.create({
    data: {
      id: serviceId,
      sellerId,
      category: "credit_report",
      endpoint: "http://127.0.0.1:9/test",
      method: "POST",
      priceAtomic: "50000",
      tokenSymbol: "USDC",
      tokenAddress: BASE_SEPOLIA_USDC,
      tokenDecimals: 6,
      network: MELLO_NETWORK,
      supportsTwInvoice: true,
    },
  });
  await prisma.task.createMany({
    data: taskIds.map((id) => ({ id, prompt: `concurrency test ${id}` })),
  });
  return { buyerProfileId, sellerId, serviceId, taskIds };
}

async function createReservedPurchase(input: {
  transaction: Parameters<
    Parameters<typeof withDailySpendReservationLock>[2]
  >[0]["transaction"];
  buyerProfileId: string;
  serviceId: string;
  taskId: string;
  withRetryRecords?: boolean;
}): Promise<{ purchaseId: string; invoiceId?: string; anchorId?: string }> {
  const purchaseId = randomUUID();
  const paymentId = `payment-${randomUUID()}`;
  const authorizationNonce = `0x${randomUUID().replaceAll("-", "").repeat(2)}`;
  const invoiceId = input.withRetryRecords ? randomUUID() : undefined;
  const anchorId = input.withRetryRecords ? randomUUID() : undefined;
  fixtureIds.purchases.push(purchaseId);
  if (input.withRetryRecords) {
    await input.transaction.task.update({
      where: { id: input.taskId },
      data: {
        status: "ACTION_REQUIRED",
        intent: {
          targetCompanyName: "Example Co.",
          requiresTwInvoice: true,
          buyerBusinessId: "12345675",
          maxAmount: { atomic: "50000", display: "0.05", currency: "USDC" },
          networkPreference: MELLO_NETWORK,
          category: "credit_report",
        },
      },
    });
  }
  await input.transaction.purchase.create({
    data: {
      id: purchaseId,
      taskId: input.taskId,
      buyerProfileId: input.buyerProfileId,
      serviceId: input.serviceId,
      paymentId,
      expectedAmountAtomic: "50000",
      actualAmountAtomic: input.withRetryRecords ? "50000" : null,
      network: MELLO_NETWORK,
      tokenSymbol: "USDC",
      tokenAddress: BASE_SEPOLIA_USDC,
      tokenDecimals: 6,
      buyerAddress: BUYER,
      payToAddress: SELLER_ADDRESS,
      policySnapshot: {
        version: 1,
        perTxLimitAtomic: "50000",
        dailyLimitAtomic: "50000",
        requireTwInvoice: input.withRetryRecords === true,
        allowedNetworks: [MELLO_NETWORK],
        allowedTokens: [
          { symbol: "USDC", address: BASE_SEPOLIA_USDC, decimals: 6 },
        ],
        allowedSellerIds: ["seller-b"],
      },
      mandateHash: HASH,
      policyHash: HASH,
      expiresAt: new Date(NOW.getTime() + 600_000),
      createdAt: NOW,
      status: input.withRetryRecords ? "ACTION_REQUIRED" : "AUTH_ANCHOR_PENDING",
      payment: {
        create: {
          paymentId,
          status: input.withRetryRecords ? "SETTLED" : "NOT_STARTED",
          ...(input.withRetryRecords
            ? {
                amountAtomic: "50000",
                transactionHash: HASH,
                payerAddress: BUYER,
                payeeAddress: SELLER_ADDRESS,
                network: MELLO_NETWORK,
                tokenAddress: BASE_SEPOLIA_USDC,
                settledAt: NOW,
              }
            : {}),
        },
      },
      ...(input.withRetryRecords
        ? {
            authorization: {
              create: {
                paymentId,
                network: MELLO_NETWORK,
                tokenAddress: BASE_SEPOLIA_USDC,
                fromAddress: BUYER,
                toAddress: SELLER_ADDRESS,
                amountAtomic: "50000",
                nonce: authorizationNonce,
                validAfter: 1n,
                validBefore: 300n,
                eip712Name: "USD Coin",
                eip712Version: "2",
                eip712ChainId: 84532n,
                typedDataHash: HASH,
                signatureHash: HASH,
                status: "SETTLED" as const,
                settlementTxHash: HASH,
              },
            },
          }
        : {}),
      ...(input.withRetryRecords
        ? {
            invoice: {
              create: {
                id: invoiceId!,
                status: "FAILED_RETRYABLE" as const,
                provider: "MOCK" as const,
                canonicalHash: HASH,
              },
            },
            delivery: {
              create: {
                status: "DELIVERED" as const,
                responseHash: HASH,
                deliveredAt: NOW,
              },
            },
            reconciliation: {
              create: {
                status: "MATCHED" as const,
                checks: [],
                canonicalHash: HASH,
                reconciledAt: NOW,
              },
            },
            anchors: {
              create: {
                id: anchorId!,
                kind: "FINALIZE" as const,
                status: "FAILED_RETRYABLE" as const,
              },
            },
          }
        : {}),
    },
  });
  return { purchaseId, ...(invoiceId ? { invoiceId } : {}), ...(anchorId ? { anchorId } : {}) };
}

async function cleanup(): Promise<void> {
  if (fixtureIds.purchases.length > 0) {
    await prisma.purchase.deleteMany({ where: { id: { in: fixtureIds.purchases } } });
  }
  if (fixtureIds.tasks.length > 0) {
    await prisma.auditEvent.deleteMany({ where: { taskId: { in: fixtureIds.tasks } } });
    await prisma.task.deleteMany({ where: { id: { in: fixtureIds.tasks } } });
  }
  if (fixtureIds.services.length > 0) {
    await prisma.service.deleteMany({ where: { id: { in: fixtureIds.services } } });
  }
  if (fixtureIds.sellers.length > 0) {
    await prisma.seller.deleteMany({ where: { id: { in: fixtureIds.sellers } } });
  }
  if (fixtureIds.companies.length > 0) {
    await prisma.companyProfile.deleteMany({ where: { id: { in: fixtureIds.companies } } });
  }
  for (const ids of Object.values(fixtureIds)) ids.splice(0, ids.length);
}

async function currentReservedAtomic(buyerProfileId: string): Promise<string> {
  return withDailySpendReservationLock(
    prisma,
    { buyerProfileId, now: NOW },
    async ({ reservedAtomic }) => reservedAtomic,
  );
}

function createWorkflow(input: {
  invoiceAdapter: InvoiceAdapter;
  anchorClient: AuditAnchorClient;
  paymentProvider: PaymentProvider;
}): PurchaseWorkflow {
  return new PurchaseWorkflow({
    prisma,
    config: loadConfig({ DATABASE_URL: process.env["DATABASE_URL"] ?? "postgresql://invalid" }),
    agent: {} as never,
    invoiceAdapter: input.invoiceAdapter,
    anchorClient: input.anchorClient,
    paymentProvider: input.paymentProvider,
    logger: { error: vi.fn() } as never,
    now: () => NOW,
  });
}

describe.skipIf(!RUN_INTEGRATION_TESTS).sequential(
  "purchase PostgreSQL concurrency guards",
  () => {
    afterEach(cleanup);
    afterAll(async () => prisma.$disconnect());

    it("serializes same-company daily reservations so only one 0.05 purchase fits", async () => {
      const fixture = await createCatalogFixture();
      const reserve = (taskId: string) =>
        withDailySpendReservationLock(
          prisma,
          { buyerProfileId: fixture.buyerProfileId, now: NOW },
          async ({ reservedAtomic, transaction }) => {
            if (BigInt(reservedAtomic) + 50_000n > 50_000n) return false;
            // Keep the first transaction open long enough for the peer to
            // contend on the same advisory lock.
            await new Promise<void>((resolve) => setTimeout(resolve, 75));
            await createReservedPurchase({
              transaction,
              buyerProfileId: fixture.buyerProfileId,
              serviceId: fixture.serviceId,
              taskId,
            });
            return true;
          },
        );

      const results = await Promise.all(fixture.taskIds.map(reserve));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await currentReservedAtomic(fixture.buyerProfileId)).toBe("50000");

      const purchase = await prisma.purchase.findFirstOrThrow({
        where: { buyerProfileId: fixture.buyerProfileId },
        include: { payment: true },
      });
      expect(purchase.payment?.status).toBe("NOT_STARTED");

      // A terminal pre-payment failure releases the reservation.
      await prisma.purchase.update({ where: { id: purchase.id }, data: { status: "FAILED" } });
      expect(await currentReservedAtomic(fixture.buyerProfileId)).toBe("0");

      // Once submitted, pending settlement remains reserved even if the outer
      // workflow needs operator attention. A conclusive payment failure releases it.
      await prisma.payment.update({
        where: { purchaseId: purchase.id },
        data: { status: "SETTLEMENT_PENDING" },
      });
      expect(await currentReservedAtomic(fixture.buyerProfileId)).toBe("50000");
      await prisma.payment.update({
        where: { purchaseId: purchase.id },
        data: { status: "FAILED" },
      });
      expect(await currentReservedAtomic(fixture.buyerProfileId)).toBe("0");
    });

    it("carries unresolved exposure across Taipei midnight without double counting settlement", async () => {
      const fixture = await createCatalogFixture();
      const beforeMidnight = new Date("2030-01-01T15:59:59.900Z");
      const afterMidnight = new Date("2030-01-01T16:00:00.100Z");
      let signalFirstEntered!: () => void;
      let releaseFirst!: () => void;
      const firstEntered = new Promise<void>((resolve) => {
        signalFirstEntered = resolve;
      });
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      const reserve = (input: {
        now: Date;
        taskId: string;
        entered?: () => void;
        gate?: Promise<void>;
      }) =>
        withDailySpendReservationLock(
          prisma,
          { buyerProfileId: fixture.buyerProfileId, now: input.now },
          async ({ reservedAtomic, transaction }) => {
            if (BigInt(reservedAtomic) + 50_000n > 50_000n) return false;
            input.entered?.();
            await input.gate;
            await createReservedPurchase({
              transaction,
              buyerProfileId: fixture.buyerProfileId,
              serviceId: fixture.serviceId,
              taskId: input.taskId,
            });
            return true;
          },
        );

      const first = reserve({
        now: beforeMidnight,
        taskId: fixture.taskIds[0],
        entered: signalFirstEntered,
        gate: firstGate,
      });
      await firstEntered;
      const second = reserve({ now: afterMidnight, taskId: fixture.taskIds[1] });
      releaseFirst();

      expect((await Promise.all([first, second])).filter(Boolean)).toHaveLength(1);

      const purchase = await prisma.purchase.findFirstOrThrow({
        where: { buyerProfileId: fixture.buyerProfileId },
        include: { payment: true },
      });
      await prisma.purchase.update({
        where: { id: purchase.id },
        data: { createdAt: beforeMidnight },
      });

      const reservedAfterMidnight = () =>
        withDailySpendReservationLock(
          prisma,
          { buyerProfileId: fixture.buyerProfileId, now: afterMidnight },
          async ({ reservedAtomic }) => reservedAtomic,
        );

      expect(await reservedAfterMidnight()).toBe("50000");

      await prisma.payment.update({
        where: { purchaseId: purchase.id },
        data: { status: "SETTLEMENT_PENDING" },
      });
      expect(await reservedAfterMidnight()).toBe("50000");

      // Moving the same Purchase from pending exposure to today's settlement
      // keeps one reservation; it does not count both lifecycle states.
      await prisma.payment.update({
        where: { purchaseId: purchase.id },
        data: {
          status: "SETTLED",
          amountAtomic: "50000",
          settledAt: afterMidnight,
        },
      });
      await prisma.purchase.update({
        where: { id: purchase.id },
        data: { status: "COMPLETED" },
      });
      expect(await reservedAfterMidnight()).toBe("50000");

      // Historical settlement belongs to its own Taipei policy day.
      await prisma.payment.update({
        where: { purchaseId: purchase.id },
        data: { settledAt: beforeMidnight },
      });
      expect(await reservedAfterMidnight()).toBe("0");
    });

    it("uses row-level CAS so only one invoice and anchor retry can claim work", async () => {
      const fixture = await createCatalogFixture();
      const retryRecords = await withDailySpendReservationLock(
        prisma,
        { buyerProfileId: fixture.buyerProfileId, now: NOW },
        async ({ transaction }) =>
          createReservedPurchase({
            transaction,
            buyerProfileId: fixture.buyerProfileId,
            serviceId: fixture.serviceId,
            taskId: fixture.taskIds[0],
            withRetryRecords: true,
          }),
      );
      if (!retryRecords.invoiceId || !retryRecords.anchorId) {
        throw new Error("Retry records were not created");
      }

      const claimInput = (claimId: string) => ({
        claimId,
        claimedAt: NOW,
        staleBefore: new Date(NOW.getTime() - 600_000),
      });
      const race = async (
        claim: (
          transaction: Parameters<typeof claimInvoiceRetry>[0],
          claimId: string,
        ) => Promise<boolean>,
      ) => {
        const firstId = randomUUID();
        const secondId = randomUUID();
        const [first, second] = await Promise.all([
          prisma.$transaction((transaction) => claim(transaction, firstId)),
          prisma.$transaction((transaction) => claim(transaction, secondId)),
        ]);
        expect([first, second].filter(Boolean)).toHaveLength(1);
      };

      await race((transaction, claimId) =>
        claimInvoiceRetry(transaction, retryRecords.invoiceId!, claimInput(claimId)),
      );
      await race((transaction, claimId) =>
        claimAnchorRetry(transaction, retryRecords.anchorId!, claimInput(claimId)),
      );
    });

    it("returns 409 for an overlapping invoice retry and never re-enters payment", async () => {
      const fixture = await createCatalogFixture();
      const retryRecords = await withDailySpendReservationLock(
        prisma,
        { buyerProfileId: fixture.buyerProfileId, now: NOW },
        async ({ transaction }) =>
          createReservedPurchase({
            transaction,
            buyerProfileId: fixture.buyerProfileId,
            serviceId: fixture.serviceId,
            taskId: fixture.taskIds[0],
            withRetryRecords: true,
          }),
      );
      if (!retryRecords.invoiceId) throw new Error("Invoice fixture was not created");

      let releaseIssue!: () => void;
      let markIssueStarted!: () => void;
      const issueStarted = new Promise<void>((resolve) => {
        markIssueStarted = resolve;
      });
      const issueGate = new Promise<void>((resolve) => {
        releaseIssue = resolve;
      });
      const issue = vi.fn(async () => {
        markIssueStarted();
        await issueGate;
        throw new RetryableInvoiceError("controlled retry failure");
      });
      const prepare = vi.fn();
      const workflow = createWorkflow({
        invoiceAdapter: { issue, getStatus: vi.fn() },
        anchorClient: {} as AuditAnchorClient,
        paymentProvider: {
          mode: "mock",
          getAddress: async () => BUYER,
          prepare,
        },
      });

      const first = workflow.retryInvoice(retryRecords.purchaseId, "invoice-first");
      await Promise.race([
        issueStarted,
        first.then(() => {
          throw new Error("Invoice retry finished before reaching the adapter gate");
        }),
      ]);
      try {
        await expect(
          workflow.retryInvoice(retryRecords.purchaseId, "invoice-overlap"),
        ).rejects.toMatchObject({ code: "INVOICE_ISSUE_FAILED", statusCode: 409 });
      } finally {
        releaseIssue();
      }
      await first;

      expect(issue).toHaveBeenCalledOnce();
      expect(prepare).not.toHaveBeenCalled();
      await expect(
        prisma.payment.findUniqueOrThrow({ where: { purchaseId: retryRecords.purchaseId } }),
      ).resolves.toMatchObject({ status: "SETTLED", transactionHash: HASH });
      await expect(
        prisma.invoice.findUniqueOrThrow({ where: { id: retryRecords.invoiceId } }),
      ).resolves.toMatchObject({
        status: "FAILED_RETRYABLE",
        attemptCount: 1,
        retryClaimId: null,
      });
    });

    it("advances concurrent payment receipt recovery exactly once without re-paying", async () => {
      const fixture = await createCatalogFixture();
      const records = await withDailySpendReservationLock(
        prisma,
        { buyerProfileId: fixture.buyerProfileId, now: NOW },
        async ({ transaction }) =>
          createReservedPurchase({
            transaction,
            buyerProfileId: fixture.buyerProfileId,
            serviceId: fixture.serviceId,
            taskId: fixture.taskIds[0],
            withRetryRecords: true,
          }),
      );
      await prisma.$transaction([
        prisma.payment.update({
          where: { purchaseId: records.purchaseId },
          data: {
            status: "SETTLEMENT_PENDING",
            paymentResponse: { success: true, transaction: HASH },
            settledAt: null,
          },
        }),
        prisma.paymentAuthorization.update({
          where: { purchaseId: records.purchaseId },
          data: { status: "SUBMITTED", settlementTxHash: null },
        }),
        prisma.delivery.update({
          where: { purchaseId: records.purchaseId },
          data: {
            status: "PENDING",
            responseBody: { ...RECOVERY_REPORT, provider: fixture.sellerId },
            responseHash: null,
            deliveredAt: null,
          },
        }),
        prisma.reconciliation.update({
          where: { purchaseId: records.purchaseId },
          data: { status: "PENDING", checks: [], canonicalHash: null, reconciledAt: null },
        }),
        prisma.purchase.update({
          where: { id: records.purchaseId },
          data: { actualAmountAtomic: null },
        }),
      ]);

      let releaseVerification!: () => void;
      let entered = 0;
      let bothEntered!: () => void;
      const bothVerificationsEntered = new Promise<void>((resolve) => {
        bothEntered = resolve;
      });
      const verificationGate = new Promise<void>((resolve) => {
        releaseVerification = resolve;
      });
      const verifySettlement = vi.fn(async () => {
        entered += 1;
        if (entered === 2) bothEntered();
        await verificationGate;
        return { verifiedChainId: 84_532 };
      });
      const prepare = vi.fn();
      const invoiceAdapter = new MockInvoiceAdapter();
      const issue = vi.spyOn(invoiceAdapter, "issue");
      const finalizationHash = `0x${"2".repeat(64)}` as `0x${string}`;
      const anchorClient: AuditAnchorClient = {
        mode: "onchain",
        authorizePurchase: vi.fn(),
        finalizePurchase: vi.fn(async (_input, options) => {
          await options?.onSubmitted?.(finalizationHash);
          return { transactionHash: finalizationHash, blockNumber: 88n, chainId: 84_532 };
        }),
        markFailed: vi.fn(),
        reconcileTransaction: vi.fn(),
        getPurchaseState: vi.fn(async () => ({
          status: "AUTHORIZED" as const,
          paymentAuthorizationHash: HASH as `0x${string}`,
        })),
        hasContractCode: vi.fn(async () => true),
      };
      const workflow = createWorkflow({
        invoiceAdapter,
        anchorClient,
        paymentProvider: {
          mode: "x402",
          getAddress: async () => BUYER,
          prepare,
          verifySettlement,
        },
      });

      const recoveries = [
        workflow.reconcilePayment(records.purchaseId, "reconcile-first"),
        workflow.reconcilePayment(records.purchaseId, "reconcile-overlap"),
      ];
      await bothVerificationsEntered;
      releaseVerification();
      await Promise.all(recoveries);

      expect(verifySettlement).toHaveBeenCalledTimes(2);
      expect(prepare).not.toHaveBeenCalled();
      expect(issue).toHaveBeenCalledOnce();
      await expect(
        prisma.purchase.findUniqueOrThrow({
          where: { id: records.purchaseId },
          include: {
            task: true,
            payment: true,
            authorization: true,
            delivery: true,
            reconciliation: true,
          },
        }),
      ).resolves.toMatchObject({
        status: "COMPLETED",
        actualAmountAtomic: "50000",
        task: { status: "COMPLETED", errorCode: null },
        payment: { status: "SETTLED", transactionHash: HASH },
        authorization: { status: "SETTLED", settlementTxHash: HASH },
        delivery: { status: "DELIVERED" },
        reconciliation: { status: "MATCHED" },
      });
      await expect(
        prisma.auditEvent.count({
          where: {
            purchaseId: records.purchaseId,
            eventType: "PAYMENT_SETTLEMENT_RECONCILED",
          },
        }),
      ).resolves.toBe(1);
    });

    it("moves an invoice preflight mismatch to ACTION_REQUIRED without calling the adapter", async () => {
      const fixture = await createCatalogFixture();
      const retryRecords = await withDailySpendReservationLock(
        prisma,
        { buyerProfileId: fixture.buyerProfileId, now: NOW },
        async ({ transaction }) =>
          createReservedPurchase({
            transaction,
            buyerProfileId: fixture.buyerProfileId,
            serviceId: fixture.serviceId,
            taskId: fixture.taskIds[0],
            withRetryRecords: true,
          }),
      );
      await prisma.payment.update({
        where: { purchaseId: retryRecords.purchaseId },
        data: { payeeAddress: BUYER },
      });
      const issue = vi.fn(async () => {
        throw new Error("adapter must not be called");
      });
      const prepare = vi.fn();
      const workflow = createWorkflow({
        invoiceAdapter: { issue, getStatus: vi.fn(async () => "NOT_FOUND" as const) },
        anchorClient: {} as AuditAnchorClient,
        paymentProvider: {
          mode: "mock",
          getAddress: async () => BUYER,
          prepare,
        },
      });

      await workflow.retryInvoice(retryRecords.purchaseId, "preflight-mismatch");

      expect(issue).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      await expect(
        prisma.purchase.findUniqueOrThrow({
          where: { id: retryRecords.purchaseId },
          include: { task: true, reconciliation: true },
        }),
      ).resolves.toMatchObject({
        status: "ACTION_REQUIRED",
        task: { status: "ACTION_REQUIRED", errorCode: "RECONCILIATION_MISMATCH" },
        reconciliation: { status: "MISMATCH" },
      });
      await expect(
        prisma.auditEvent.findFirst({
          where: {
            purchaseId: retryRecords.purchaseId,
            eventType: "INVOICE_PREFLIGHT_REJECTED",
          },
        }),
      ).resolves.toMatchObject({ payload: expect.objectContaining({ adapterCalled: false }) });
    });

    it("returns 409 for an overlapping anchor retry without another tx or payment", async () => {
      const fixture = await createCatalogFixture();
      const retryRecords = await withDailySpendReservationLock(
        prisma,
        { buyerProfileId: fixture.buyerProfileId, now: NOW },
        async ({ transaction }) =>
          createReservedPurchase({
            transaction,
            buyerProfileId: fixture.buyerProfileId,
            serviceId: fixture.serviceId,
            taskId: fixture.taskIds[0],
            withRetryRecords: true,
          }),
      );
      if (!retryRecords.anchorId || !retryRecords.invoiceId) {
        throw new Error("Anchor fixture was not created");
      }
      await prisma.invoice.update({
        where: { id: retryRecords.invoiceId },
        data: { status: "ISSUED_DEMO" },
      });
      await prisma.onchainAnchor.update({
        where: { id: retryRecords.anchorId },
        data: { transactionHash: HASH },
      });
      await prisma.$transaction([
        prisma.task.update({
          where: { id: fixture.taskIds[0] },
          data: { status: "FINAL_ANCHOR_PENDING" },
        }),
        prisma.purchase.update({
          where: { id: retryRecords.purchaseId },
          data: { status: "FINAL_ANCHOR_PENDING" },
        }),
      ]);

      let releaseReconcile!: () => void;
      let markReconcileStarted!: () => void;
      const reconcileStarted = new Promise<void>((resolve) => {
        markReconcileStarted = resolve;
      });
      const reconcileGate = new Promise<void>((resolve) => {
        releaseReconcile = resolve;
      });
      const reconcileTransaction = vi.fn(async () => {
        markReconcileStarted();
        await reconcileGate;
        return {
          transactionHash: HASH as `0x${string}`,
          blockNumber: 77n,
          chainId: 84_532,
        };
      });
      const finalizePurchase = vi.fn();
      const prepare = vi.fn();
      const workflow = createWorkflow({
        invoiceAdapter: {} as InvoiceAdapter,
        anchorClient: {
          mode: "onchain",
          authorizePurchase: vi.fn(),
          finalizePurchase,
          markFailed: vi.fn(),
          reconcileTransaction,
          getPurchaseState: vi.fn(),
          hasContractCode: vi.fn(async () => true),
        },
        paymentProvider: {
          mode: "mock",
          getAddress: async () => BUYER,
          prepare,
        },
      });

      const first = workflow.retryAnchor(retryRecords.purchaseId, "anchor-first");
      await Promise.race([
        reconcileStarted,
        first.then(() => {
          throw new Error("Anchor retry finished before reaching the reconcile gate");
        }),
      ]);
      try {
        await expect(
          workflow.retryAnchor(retryRecords.purchaseId, "anchor-overlap"),
        ).rejects.toMatchObject({ code: "CONTRACT_ANCHOR_FAILED", statusCode: 409 });
      } finally {
        releaseReconcile();
      }
      await first;

      expect(reconcileTransaction).toHaveBeenCalledOnce();
      expect(finalizePurchase).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      await expect(
        prisma.payment.findUniqueOrThrow({ where: { purchaseId: retryRecords.purchaseId } }),
      ).resolves.toMatchObject({ status: "SETTLED", transactionHash: HASH });
      await expect(
        prisma.onchainAnchor.findUniqueOrThrow({ where: { id: retryRecords.anchorId } }),
      ).resolves.toMatchObject({
        status: "CONFIRMED",
        transactionHash: HASH,
        retryClaimId: null,
      });
    });
  },
);
