import { randomUUID } from "node:crypto";
import { prisma } from "@mello/db";
import { BASE_SEPOLIA_USDC, DEMO_COMPANY_ID, MELLO_NETWORK } from "@mello/shared";
import type { Logger } from "pino";
import supertest from "supertest";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { CoreApiDependencies } from "./contracts.js";
import { PrismaCoreApiRepository } from "./prisma-core-api-repository.js";
import { PrismaWorkflowJobRepository } from "../modules/workflow-jobs/index.js";

const RUN_INTEGRATION_TESTS = process.env["RUN_INTEGRATION_TESTS"] === "true";
const BUYER = "0x9999999999999999999999999999999999999999";
const SELLER_ADDRESS = "0x2222222222222222222222222222222222222222";
const HASH = `0x${"1".repeat(64)}`;
const TRANSACTION_HASH = `0x${"2".repeat(64)}`;
const INVALID_REQUEST_ID = "x".repeat(129);
const DEMO_ADMIN_TOKEN = "background-failure-admin-token";

const fixtureIds = {
  companies: [] as string[],
  sellers: [] as string[],
  services: [] as string[],
  tasks: [] as string[],
  purchases: [] as string[],
};

interface BackgroundFailureFixture {
  taskId: string;
  purchaseId: string;
  paymentId: string;
}

async function createFixture(): Promise<BackgroundFailureFixture> {
  const companyId = DEMO_COMPANY_ID;
  const sellerId = `background-failure-seller-${randomUUID()}`;
  const serviceId = `background-failure-service-${randomUUID()}`;
  const taskId = randomUUID();
  const purchaseId = randomUUID();
  const paymentId = `background-failure-payment-${randomUUID()}`;
  fixtureIds.sellers.push(sellerId);
  fixtureIds.services.push(serviceId);
  fixtureIds.tasks.push(taskId);
  fixtureIds.purchases.push(purchaseId);

  await prisma.seller.create({
    data: {
      id: sellerId,
      legalName: "Background Failure Test Seller",
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
      endpoint: "http://127.0.0.1:9/background-failure-test",
      method: "POST",
      priceAtomic: "50000",
      tokenSymbol: "USDC",
      tokenAddress: BASE_SEPOLIA_USDC,
      tokenDecimals: 6,
      network: MELLO_NETWORK,
      supportsTwInvoice: true,
    },
  });
  await prisma.task.create({
    data: {
      id: taskId,
      prompt: "background failure PostgreSQL atomicity",
      status: "RECONCILING",
    },
  });
  await prisma.purchase.create({
    data: {
      id: purchaseId,
      taskId,
      buyerProfileId: companyId,
      serviceId,
      paymentId,
      expectedAmountAtomic: "50000",
      network: MELLO_NETWORK,
      tokenSymbol: "USDC",
      tokenAddress: BASE_SEPOLIA_USDC,
      tokenDecimals: 6,
      buyerAddress: BUYER,
      payToAddress: SELLER_ADDRESS,
      policySnapshot: {},
      mandateHash: HASH,
      policyHash: HASH,
      expiresAt: new Date("2035-01-01T00:10:00.000Z"),
      status: "RECONCILING",
      payment: {
        create: {
          paymentId,
          status: "SETTLEMENT_PENDING",
          transactionHash: TRANSACTION_HASH,
        },
      },
    },
  });
  return { taskId, purchaseId, paymentId };
}

async function cleanup(): Promise<void> {
  if (fixtureIds.purchases.length > 0 || fixtureIds.tasks.length > 0) {
    await prisma.workflowJob.deleteMany({
      where: {
        aggregateId: { in: [...fixtureIds.purchases, ...fixtureIds.tasks] },
      },
    });
    await prisma.auditEvent.deleteMany({
      where: {
        OR: [
          { purchaseId: { in: fixtureIds.purchases } },
          { taskId: { in: fixtureIds.tasks } },
        ],
      },
    });
  }
  if (fixtureIds.purchases.length > 0) {
    await prisma.purchase.deleteMany({ where: { id: { in: fixtureIds.purchases } } });
  }
  if (fixtureIds.tasks.length > 0) {
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

function config() {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL:
      process.env["DATABASE_URL"] ??
      "postgresql://mello:mello@localhost:5432/mello_test",
    DEMO_ADMIN_TOKEN,
  });
}

function logger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

describe.skipIf(!RUN_INTEGRATION_TESTS).sequential(
  "PrismaCoreApiRepository PostgreSQL background failure atomicity",
  () => {
    afterEach(cleanup);
    afterAll(async () => prisma.$disconnect());

    it("rolls back guarded Task and Purchase changes when the audit insert fails", async () => {
      const fixture = await createFixture();
      const repository = new PrismaCoreApiRepository(prisma, config());

      await expect(
        repository.recordBackgroundFailure({
          operation: "RUN_TASK",
          taskId: fixture.taskId,
          purchaseId: fixture.purchaseId,
          requestId: INVALID_REQUEST_ID,
          error: new Error("worker lease exhausted"),
        }),
      ).rejects.toThrow();

      const [task, purchase, auditCount] = await Promise.all([
        prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } }),
        prisma.purchase.findUniqueOrThrow({ where: { id: fixture.purchaseId } }),
        prisma.auditEvent.count({
          where: {
            taskId: fixture.taskId,
            eventType: "BACKGROUND_RUN_TASK_FAILED_FINAL",
          },
        }),
      ]);
      expect(task).toMatchObject({
        status: "RECONCILING",
        errorCode: null,
        errorMessage: null,
      });
      expect(purchase.status).toBe("RECONCILING");
      expect(auditCount).toBe(0);
    });

    it("serializes duplicate reconciliation failures and appends exactly one audit", async () => {
      const fixture = await createFixture();
      const repository = new PrismaCoreApiRepository(prisma, config());
      const failure = () =>
        repository.recordBackgroundFailure({
          operation: "RECONCILE_PAYMENT",
          taskId: fixture.taskId,
          purchaseId: fixture.purchaseId,
          requestId: "same-reconciliation-final-failure",
          error: new Error("receipt verification exhausted"),
        });

      await expect(Promise.all([failure(), failure()])).resolves.toEqual([
        undefined,
        undefined,
      ]);

      const [task, purchase, auditCount] = await Promise.all([
        prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } }),
        prisma.purchase.findUniqueOrThrow({ where: { id: fixture.purchaseId } }),
        prisma.auditEvent.count({
          where: {
            purchaseId: fixture.purchaseId,
            eventType: "BACKGROUND_RECONCILE_PAYMENT_FAILED_FINAL",
            requestId: "same-reconciliation-final-failure",
          },
        }),
      ]);
      expect(task).toMatchObject({
        status: "ACTION_REQUIRED",
        errorMessage: "receipt verification exhausted",
      });
      expect(purchase.status).toBe("ACTION_REQUIRED");
      expect(auditCount).toBe(1);
    });

    it("enqueues RECONCILE_PAYMENT through the authenticated endpoint in PostgreSQL", async () => {
      const fixture = await createFixture();
      const appConfig = config();
      const repository = new PrismaCoreApiRepository(prisma, appConfig);
      const workflowJobs = new PrismaWorkflowJobRepository(
        prisma,
        () => new Date("2035-01-01T00:00:00.000Z"),
      );
      const dependencies: CoreApiDependencies = {
        config: appConfig,
        repository,
        workflowJobs,
        workflow: {
          run: vi.fn(async () => undefined),
          retryInvoice: vi.fn(async () => undefined),
          retryAnchor: vi.fn(async () => undefined),
          reconcilePayment: vi.fn(async () => undefined),
        },
        workflowJobPoller: {
          start: vi.fn(),
          stop: vi.fn(async () => undefined),
          runOnce: vi.fn(async () => false),
        },
        healthService: { check: vi.fn(async () => ({ status: "ok" })) },
        logger: logger(),
      };

      const response = await supertest(createApp(dependencies))
        .post(`/api/v1/purchases/${fixture.purchaseId}/reconcile-payment`)
        .set("x-demo-admin-token", DEMO_ADMIN_TOKEN)
        .set("x-request-id", "postgres-reconcile-enqueue")
        .expect(202);

      expect(response.body).toEqual({
        purchaseId: fixture.purchaseId,
        status: "PENDING_RECONCILIATION",
      });
      await expect(
        prisma.workflowJob.findFirst({
          where: {
            kind: "RECONCILE_PAYMENT",
            aggregateId: fixture.purchaseId,
          },
        }),
      ).resolves.toMatchObject({
        status: "PENDING",
        payload: {
          taskId: fixture.taskId,
          purchaseId: fixture.purchaseId,
          requestId: "postgres-reconcile-enqueue",
        },
      });
      await expect(
        prisma.auditEvent.count({
          where: {
            purchaseId: fixture.purchaseId,
            eventType: "WORKFLOW_JOB_ENQUEUED",
          },
        }),
      ).resolves.toBe(1);
    });
  },
);
