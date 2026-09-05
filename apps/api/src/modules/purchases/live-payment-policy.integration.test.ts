import { randomUUID } from "node:crypto";
import { MockAuditAnchorClient } from "@mello/contracts-client";
import { prisma } from "@mello/db";
import {
  MELLO_NETWORK,
  PolicyInputSchema,
  formatUsdcAtomic,
} from "@mello/shared";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../config.js";
import { MockInvoiceAdapter } from "../invoices/index.js";
import type { ProcurementAgent } from "../procurement-agent/index.js";
import type {
  PaymentProvider,
  PreparePaymentInput,
  ValidatedPaymentTerms,
} from "../x402-buyer/index.js";
import { PurchaseWorkflow } from "./purchase-workflow.js";

const BUYER = "0x9999999999999999999999999999999999999999" as const;
const MALICIOUS_PAYEE = "0x3333333333333333333333333333333333333333" as const;
const NOW = new Date("2030-01-01T04:00:00.000Z");
const taskIds: string[] = [];

async function cleanup(): Promise<void> {
  if (taskIds.length === 0) return;
  const purchases = await prisma.purchase.findMany({
    where: { taskId: { in: taskIds } },
    select: { id: true },
  });
  await prisma.auditEvent.deleteMany({ where: { taskId: { in: taskIds } } });
  if (purchases.length > 0) {
    await prisma.purchase.deleteMany({
      where: { id: { in: purchases.map(({ id }) => id) } },
    });
  }
  await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
  taskIds.splice(0, taskIds.length);
}

describe.sequential("live x402 policy boundary", () => {
  afterEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("persists PAY_TO_ADDRESS_MISMATCH and stops before authorization signing", async () => {
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
    const service = services.find(
      (candidate) =>
        candidate.supportsTwInvoice &&
        candidate.seller.status === "ACTIVE" &&
        policy.allowedSellerIds.includes(candidate.sellerId as "seller-a" | "seller-b"),
    );
    if (!service) throw new Error("Seeded invoice-capable service is missing");

    const taskId = randomUUID();
    taskIds.push(taskId);
    await prisma.task.create({
      data: { id: taskId, prompt: "reject malicious live payment payee" },
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

    let signatureAttempted = false;
    const prepare = vi.fn(async (input: PreparePaymentInput) => {
      const liveTerms: ValidatedPaymentTerms = {
        scheme: "exact",
        network: input.network,
        tokenAddress: input.tokenAddress,
        tokenSymbol: "USDC",
        tokenDecimals: 6,
        payToAddress: MALICIOUS_PAYEE,
        amountAtomic: input.amountAtomic,
        transferMethod: "eip3009",
        facilitatorUrl: input.expectedFacilitatorUrl?.replace(/\/$/u, "") ?? null,
      };
      await input.onLivePaymentTerms?.(liveTerms);
      signatureAttempted = true;
      throw new Error("Policy callback unexpectedly allowed signing");
    });
    const paymentProvider: PaymentProvider = {
      mode: "x402",
      getAddress: vi.fn(async () => BUYER),
      prepare,
    };
    const logger = { error: vi.fn() };
    const workflow = new PurchaseWorkflow({
      prisma,
      config: loadConfig({
        DATABASE_URL: process.env["DATABASE_URL"] ?? "postgresql://invalid",
      }),
      agent,
      paymentProvider,
      invoiceAdapter: new MockInvoiceAdapter(false),
      anchorClient: new MockAuditAnchorClient(),
      logger: logger as never,
      now: () => NOW,
    });

    await workflow.run(taskId, "live-payee-policy-test");

    const task = await prisma.task.findUniqueOrThrow({
      where: { id: taskId },
      include: {
        purchase: { include: { payment: true, authorization: true } },
      },
    });
    expect(signatureAttempted).toBe(false);
    expect(prepare).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
    expect(task).toMatchObject({
      status: "REJECTED",
      errorCode: "POLICY_REJECTED",
      purchase: {
        status: "FAILED",
        payment: { status: "NOT_STARTED" },
        authorization: null,
      },
    });
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { taskId, eventType: "POLICY_REJECTED" },
    });
    expect(event.payload).toMatchObject({
      approved: false,
      reasonCodes: ["PAY_TO_ADDRESS_MISMATCH"],
      paymentCreated: false,
      rejectedBeforeSigning: true,
      livePaymentTerms: { payToAddress: MALICIOUS_PAYEE },
    });
  });
});
