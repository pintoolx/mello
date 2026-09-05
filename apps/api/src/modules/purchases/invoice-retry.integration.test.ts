import { randomUUID } from "node:crypto";
import { MockAuditAnchorClient } from "@mello/contracts-client";
import { prisma } from "@mello/db";
import {
  BASE_SEPOLIA_USDC,
  MELLO_NETWORK,
  PolicyInputSchema,
  formatUsdcAtomic,
  hashCanonicalJson,
} from "@mello/shared";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../config.js";
import { MockInvoiceAdapter } from "../invoices/index.js";
import type { ProcurementAgent } from "../procurement-agent/index.js";
import {
  authorizationEvidenceHash,
  buildAuthorizationRecord,
  type PaymentProvider,
  type PaymentSettlement,
  type PreparePaymentInput,
  type PreparedPayment,
} from "../x402-buyer/index.js";
import { PurchaseWorkflow } from "./purchase-workflow.js";

const BUYER = "0x9999999999999999999999999999999999999999" as const;
const SETTLEMENT_TX = `0x${"7".repeat(64)}` as const;
const NOW = new Date("2030-01-01T04:00:00.000Z");
const taskIds: string[] = [];

async function cleanup(): Promise<void> {
  if (taskIds.length === 0) return;
  const purchases = await prisma.purchase.findMany({
    where: { taskId: { in: taskIds } },
    select: { id: true },
  });
  const purchaseIds = purchases.map(({ id }) => id);
  await prisma.auditEvent.deleteMany({
    where: {
      OR: [
        { taskId: { in: taskIds } },
        ...(purchaseIds.length > 0 ? [{ purchaseId: { in: purchaseIds } }] : []),
      ],
    },
  });
  if (purchaseIds.length > 0) {
    await prisma.purchase.deleteMany({ where: { id: { in: purchaseIds } } });
  }
  await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
  taskIds.splice(0, taskIds.length);
}

describe.sequential("invoice fail-once PostgreSQL recovery", () => {
    afterEach(cleanup);
    afterAll(async () => prisma.$disconnect());

    it("retries only the invoice and preserves the single settlement", async () => {
      const [company, policyRecord, services] = await Promise.all([
        prisma.companyProfile.findFirstOrThrow({ orderBy: { createdAt: "asc" } }),
        prisma.policy.findFirstOrThrow({ where: { active: true } }),
        prisma.service.findMany({
          where: { category: "credit_report", active: true },
          include: { seller: true },
        }),
      ]);
      const policy = PolicyInputSchema.parse({
        perTxLimitAtomic: policyRecord.perTxLimitAtomic,
        dailyLimitAtomic: policyRecord.dailyLimitAtomic,
        requireTwInvoice: policyRecord.requireTwInvoice,
        allowedNetworks: policyRecord.allowedNetworks,
        allowedTokens: policyRecord.allowedTokens,
        allowedSellerIds: policyRecord.allowedSellerIds,
      });
      const invoiceService = services.find(
        (service) =>
          service.supportsTwInvoice &&
          service.seller.status === "ACTIVE" &&
          service.seller.invoiceCapability === "TW_B2B_DEMO" &&
          service.seller.invoiceProvider === "MOCK" &&
          service.seller.businessId !== null &&
          policy.allowedSellerIds.includes(service.sellerId as "seller-a" | "seller-b") &&
          policy.allowedNetworks.includes(service.network as typeof MELLO_NETWORK) &&
          policy.allowedTokens.some(
            (token) =>
              token.symbol === service.tokenSymbol &&
              token.address.toLowerCase() === service.tokenAddress.toLowerCase() &&
              token.decimals === service.tokenDecimals,
          ) &&
          BigInt(service.priceAtomic) <= BigInt(policy.perTxLimitAtomic) &&
          BigInt(service.priceAtomic) <= BigInt(policy.dailyLimitAtomic),
      );
      if (!invoiceService) {
        throw new Error("Seeded PostgreSQL fixture has no policy-eligible invoice service");
      }

      const taskId = randomUUID();
      taskIds.push(taskId);
      await prisma.task.create({
        data: { id: taskId, prompt: "invoice fail-once PostgreSQL integration" },
      });

      const agent = {
        parse: vi.fn(async () => ({
          intent: {
            serviceCategory: "credit_report" as const,
            targetCompanyName: "Example Co.",
            maxAmount: {
              atomic: policy.perTxLimitAtomic,
              display: formatUsdcAtomic(policy.perTxLimitAtomic),
              token: "USDC" as const,
            },
            requiresTwInvoice: true,
            buyerBusinessId: company.businessId,
            costCenter: company.defaultCostCenter,
            networkPreference: MELLO_NETWORK,
            usedDemoDefaultTarget: false,
          },
          usedFallback: false,
        })),
      } as unknown as ProcurementAgent;

      const submit = vi.fn(
        async (input: PreparePaymentInput): Promise<PaymentSettlement> => ({
          paymentId: input.paymentId,
          transactionHash: SETTLEMENT_TX,
          payerAddress: input.payerAddress,
          payeeAddress: input.payToAddress,
          amountAtomic: input.amountAtomic,
          network: input.network,
          tokenAddress: input.tokenAddress,
          paymentResponse: { success: true, transaction: SETTLEMENT_TX },
          report: {
            reportId: `report-${input.purchaseId}`,
            provider: input.sellerId,
            targetCompanyName: input.targetCompanyName,
            riskScore: 12,
            riskLevel: "LOW",
            summary: "Deterministic integration report",
            generatedAt: NOW.toISOString(),
          },
        }),
      );
      const prepare = vi.fn(
        async (input: PreparePaymentInput): Promise<PreparedPayment> => {
          expect(
            await prisma.auditEvent.count({
              where: { taskId, eventType: "POLICY_APPROVED" },
            }),
          ).toBe(0);
          const authorization = buildAuthorizationRecord({
            purchaseId: input.purchaseId,
            paymentId: input.paymentId,
            network: input.network,
            tokenAddress: input.tokenAddress,
            from: input.payerAddress,
            to: input.payToAddress,
            value: input.amountAtomic,
            ttlSeconds: 300,
            nowSeconds: BigInt(Math.floor(NOW.getTime() / 1_000)),
            nonce: hashCanonicalJson({ schemaVersion: "invoice-retry-test", taskId }),
          });
          return {
            authorization,
            authorizationHash: authorizationEvidenceHash(authorization),
            paymentRequired: { x402Version: 2, accepts: [] },
            validatedTerms: {
              scheme: "exact",
              network: input.network,
              tokenAddress: input.tokenAddress,
              tokenSymbol: "USDC",
              tokenDecimals: 6,
              payToAddress: input.payToAddress,
              amountAtomic: input.amountAtomic,
              transferMethod: "eip3009",
              facilitatorUrl: input.expectedFacilitatorUrl?.replace(/\/$/u, "") ?? null,
            },
            cancel: vi.fn(),
            submit: async (hooks) => {
              await hooks?.onBeforePaidRequest?.();
              await hooks?.onPaidRequestReleased?.();
              return submit(input);
            },
          };
        },
      );
      const paymentProvider: PaymentProvider = {
        mode: "mock",
        getAddress: vi.fn(async () => BUYER),
        prepare,
      };
      const invoiceAdapter = new MockInvoiceAdapter(true);
      const issue = vi.spyOn(invoiceAdapter, "issue");
      const workflow = new PurchaseWorkflow({
        prisma,
        config: loadConfig({
          DATABASE_URL: process.env["DATABASE_URL"] ?? "postgresql://invalid",
        }),
        agent,
        paymentProvider,
        invoiceAdapter,
        anchorClient: new MockAuditAnchorClient(),
        logger: { error: vi.fn() } as never,
        now: () => NOW,
      });

      await workflow.run(taskId, "invoice-fail-once");

      const failed = await prisma.task.findUniqueOrThrow({
        where: { id: taskId },
        include: {
          purchase: {
            include: {
              payment: true,
              delivery: true,
              invoice: true,
              reconciliation: true,
            },
          },
        },
      });
      expect(failed).toMatchObject({
        status: "ACTION_REQUIRED",
        errorCode: "INVOICE_ISSUE_FAILED",
        purchase: {
          status: "ACTION_REQUIRED",
          payment: { status: "SETTLED", transactionHash: SETTLEMENT_TX },
          delivery: { status: "DELIVERED" },
          invoice: { status: "FAILED_RETRYABLE", attemptCount: 1 },
          reconciliation: { status: "PENDING" },
        },
      });
      const failedPurchase = failed.purchase;
      if (!failedPurchase?.payment) throw new Error("Failed purchase payment is missing");
      const policyApproved = await prisma.auditEvent.findFirstOrThrow({
        where: { purchaseId: failedPurchase.id, eventType: "POLICY_APPROVED" },
      });
      expect(policyApproved.payload).toMatchObject({
        approved: true,
        reasonCodes: expect.arrayContaining(["LIVE_PAYMENT_TERMS_VALIDATED"]),
        livePaymentTerms: {
          amountAtomic: "50000",
          payToAddress: invoiceService.seller.payToAddress,
          network: MELLO_NETWORK,
          tokenAddress: BASE_SEPOLIA_USDC,
          facilitatorUrl: "https://x402.org/facilitator",
        },
      });
      const paymentIdBefore = failedPurchase.payment.paymentId;
      const transactionHashBefore = failedPurchase.payment.transactionHash;

      expect(failedPurchase.buyerProfileSnapshot).toMatchObject({ legalName: company.legalName, businessId: company.businessId, email: company.invoiceEmail || company.email });
      // A settings edit between issue attempts must not rewrite this purchase's
      // invoice identity or cause a false business-ID reconciliation failure.
      await prisma.companyProfile.update({ where: { id: company.id }, data: { legalName: "Updated company", businessId: "24536806", invoiceEmail: "changed@example.test" } });
      try {
        await workflow.retryInvoice(failedPurchase.id, "invoice-retry");
        expect(issue).toHaveBeenLastCalledWith(expect.objectContaining({
          buyerBusinessId: company.businessId,
          buyerProfile: expect.objectContaining({ legalName: company.legalName, businessId: company.businessId, email: company.invoiceEmail || company.email }),
        }));
      } finally {
        await prisma.companyProfile.update({ where: { id: company.id }, data: { legalName: company.legalName, businessId: company.businessId, invoiceEmail: company.invoiceEmail } });
      }

      const completed = await prisma.task.findUniqueOrThrow({
        where: { id: taskId },
        include: {
          purchase: {
            include: {
              payment: true,
              delivery: true,
              invoice: true,
              reconciliation: true,
              anchors: true,
            },
          },
        },
      });
      expect(completed).toMatchObject({
        status: "COMPLETED",
        errorCode: null,
        purchase: {
          status: "COMPLETED",
          payment: {
            status: "SETTLED",
            paymentId: paymentIdBefore,
            transactionHash: transactionHashBefore,
          },
          delivery: { status: "DELIVERED" },
          invoice: { status: "ISSUED_DEMO", attemptCount: 2 },
          reconciliation: { status: "MATCHED" },
        },
      });
      expect(completed.purchase?.anchors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "AUTHORIZE", status: "CONFIRMED" }),
          expect.objectContaining({ kind: "FINALIZE", status: "CONFIRMED" }),
        ]),
      );
      expect(prepare).toHaveBeenCalledOnce();
      expect(submit).toHaveBeenCalledOnce();
      expect(issue).toHaveBeenCalledTimes(2);
      expect(
        await prisma.auditEvent.count({
          where: {
            purchaseId: failedPurchase.id,
            eventType: "PAYMENT_SETTLEMENT_AND_DELIVERY_CONFIRMED",
          },
        }),
      ).toBe(1);
      const lifecycle = (
        await prisma.auditEvent.findMany({
          where: { purchaseId: failedPurchase.id },
          orderBy: { sequence: "asc" },
          select: { eventType: true },
        })
      ).map((event) => event.eventType);
      const durableStages = [
        "PAYMENT_SETTLEMENT_AND_DELIVERY_CONFIRMED",
        "INVOICING_STARTED",
        "RECONCILIATION_STARTED",
        "RECONCILIATION_MATCHED",
        "PURCHASE_COMPLETED",
      ];
      expect(durableStages.map((eventType) => lifecycle.indexOf(eventType))).toEqual(
        [...durableStages]
          .map((eventType) => lifecycle.indexOf(eventType))
          .sort((left, right) => left - right),
      );
      expect(durableStages.every((eventType) => lifecycle.includes(eventType))).toBe(true);
    });
});
