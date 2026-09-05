import { randomUUID } from "node:crypto";
import { prisma } from "@mello/db";
import { BASE_SEPOLIA_USDC, DEMO_COMPANY_ID, MELLO_NETWORK } from "@mello/shared";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { InvoiceIssueResult } from "../invoices/index.js";
import {
  beginAnchorAttempt,
  confirmAnchorState,
  persistIssuedInvoice,
  startTaskRun,
  transitionPurchaseWorkflowStage,
} from "./workflow-state-transitions.js";

const RUN_INTEGRATION_TESTS =
  process.env["RUN_INTEGRATION_TESTS"] === "true" ||
  process.env["RUN_WORKFLOW_ATOMICITY_INTEGRATION_TESTS"] === "true";

const BUYER = "0x9999999999999999999999999999999999999999";
const SELLER_ADDRESS = "0x2222222222222222222222222222222222222222";
const CONTRACT_ADDRESS = "0x3333333333333333333333333333333333333333";
const HASH = `0x${"1".repeat(64)}` as const;
const TX_HASH = `0x${"2".repeat(64)}` as const;
const NOW = new Date("2030-01-01T04:00:00.000Z");
const INVALID_REQUEST_ID = "x".repeat(129);

const fixtureIds = {
  companies: [] as string[],
  sellers: [] as string[],
  services: [] as string[],
  tasks: [] as string[],
  purchases: [] as string[],
};

interface AtomicityFixture {
  taskId: string;
  purchaseId: string;
  paymentId: string;
  invoiceId: string;
  sellerId: string;
}

async function createFixture(): Promise<AtomicityFixture> {
  const companyId = DEMO_COMPANY_ID;
  const sellerId = `atomicity-seller-${randomUUID()}`;
  const serviceId = `atomicity-service-${randomUUID()}`;
  const taskId = randomUUID();
  const purchaseId = randomUUID();
  const invoiceId = randomUUID();
  const paymentId = `payment-${randomUUID()}`;
  fixtureIds.sellers.push(sellerId);
  fixtureIds.services.push(serviceId);
  fixtureIds.tasks.push(taskId);
  fixtureIds.purchases.push(purchaseId);

  await prisma.seller.create({
    data: {
      id: sellerId,
      legalName: "Atomicity Test Seller",
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
      endpoint: "http://127.0.0.1:9/atomicity-test",
      method: "POST",
      priceAtomic: "50000",
      tokenSymbol: "USDC",
      tokenAddress: BASE_SEPOLIA_USDC,
      tokenDecimals: 6,
      network: MELLO_NETWORK,
      supportsTwInvoice: true,
    },
  });
  await prisma.task.create({ data: { id: taskId, prompt: "atomic workflow transitions" } });
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
      expiresAt: new Date(NOW.getTime() + 600_000),
      status: "AUTH_ANCHOR_PENDING",
      invoice: { create: { id: invoiceId, status: "PENDING", provider: "MOCK" } },
      anchors: {
        create: { kind: "AUTHORIZE", status: "NOT_STARTED" },
      },
    },
  });
  return { taskId, purchaseId, paymentId, invoiceId, sellerId };
}

function issuedInvoice(fixture: AtomicityFixture): InvoiceIssueResult {
  return {
    status: "ISSUED_DEMO",
    provider: "MOCK",
    providerReference: `ref-${fixture.invoiceId}`,
    invoiceNumber: "DEMO-INV-20300101-ABC123",
    buyerBusinessId: "12345675",
    sellerBusinessId: "24536806",
    sellerProfileId: fixture.sellerId,
    sourceAmountAtomic: "50000",
    fxRateTwdPerUsdc: "32.5",
    twdEquivalentMinor: "163",
    itemName: "Example Co. 信用報告",
    paymentId: fixture.paymentId,
    paymentTxHash: TX_HASH,
    canonicalHash: HASH,
    disclaimer: "test invoice",
    issuedAt: NOW.toISOString(),
  };
}

async function cleanup(): Promise<void> {
  if (fixtureIds.purchases.length > 0) {
    await prisma.auditEvent.deleteMany({ where: { purchaseId: { in: fixtureIds.purchases } } });
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

describe.skipIf(!RUN_INTEGRATION_TESTS).sequential(
  "workflow state and audit PostgreSQL atomicity",
  () => {
    afterEach(cleanup);
    afterAll(async () => prisma.$disconnect());

    it("rolls back task start when its audit insert fails and enforces the start CAS", async () => {
      const fixture = await createFixture();

      await expect(
        startTaskRun(prisma, {
          taskId: fixture.taskId,
          startedAt: NOW,
          requestId: INVALID_REQUEST_ID,
        }),
      ).rejects.toThrow();
      await expect(prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).resolves.toMatchObject({
        status: "CREATED",
        runStartedAt: null,
      });

      await startTaskRun(prisma, { taskId: fixture.taskId, startedAt: NOW, requestId: "task-ok" });
      await expect(
        startTaskRun(prisma, { taskId: fixture.taskId, startedAt: NOW, requestId: "task-race" }),
      ).rejects.toMatchObject({ code: "TASK_ALREADY_RUNNING", statusCode: 409 });
      await expect(
        prisma.auditEvent.count({
          where: { taskId: fixture.taskId, eventType: "TASK_RUN_STARTED" },
        }),
      ).resolves.toBe(1);
    });

    it("rolls back issued invoice evidence when its audit insert fails and enforces CAS", async () => {
      const fixture = await createFixture();
      const invoice = issuedInvoice(fixture);
      const context = {
        invoiceId: fixture.invoiceId,
        invoice,
        taskId: fixture.taskId,
        purchaseId: fixture.purchaseId,
        paymentId: fixture.paymentId,
        sellerId: fixture.sellerId,
      };

      await expect(
        persistIssuedInvoice(prisma, { ...context, requestId: INVALID_REQUEST_ID }),
      ).rejects.toThrow();
      await expect(
        prisma.invoice.findUniqueOrThrow({ where: { id: fixture.invoiceId } }),
      ).resolves.toMatchObject({ status: "PENDING", attemptCount: 0, invoiceNumber: null });

      await persistIssuedInvoice(prisma, { ...context, requestId: "invoice-ok" });
      await expect(
        persistIssuedInvoice(prisma, { ...context, requestId: "invoice-race" }),
      ).rejects.toMatchObject({ code: "INVOICE_ISSUE_FAILED", statusCode: 409 });
      await expect(
        prisma.invoice.findUniqueOrThrow({ where: { id: fixture.invoiceId } }),
      ).resolves.toMatchObject({
        status: "ISSUED_DEMO",
        attemptCount: 1,
        invoiceNumber: invoice.invoiceNumber,
      });
      await expect(
        prisma.auditEvent.count({
          where: { purchaseId: fixture.purchaseId, eventType: "INVOICE_ISSUED" },
        }),
      ).resolves.toBe(1);
    });

    it("rolls back an anchor attempt when its audit insert fails and enforces CAS", async () => {
      const fixture = await createFixture();
      const context = {
        purchaseId: fixture.purchaseId,
        kind: "AUTHORIZE" as const,
        contractAddress: CONTRACT_ADDRESS,
      };

      await expect(
        beginAnchorAttempt(prisma, { ...context, requestId: INVALID_REQUEST_ID }),
      ).rejects.toThrow();
      await expect(
        prisma.onchainAnchor.findUniqueOrThrow({
          where: { purchaseId_kind: { purchaseId: fixture.purchaseId, kind: "AUTHORIZE" } },
        }),
      ).resolves.toMatchObject({ status: "NOT_STARTED", attemptCount: 0 });

      await beginAnchorAttempt(prisma, { ...context, requestId: "attempt-ok" });
      await expect(
        beginAnchorAttempt(prisma, { ...context, requestId: "attempt-race" }),
      ).rejects.toMatchObject({ code: "CONTRACT_ANCHOR_FAILED", statusCode: 409 });
      await expect(
        prisma.auditEvent.count({
          where: { purchaseId: fixture.purchaseId, eventType: "AUTHORIZE_ANCHOR_ATTEMPT_STARTED" },
        }),
      ).resolves.toBe(1);
    });

    it("atomically confirms AUTHORIZE, advances purchase, and appends its audit", async () => {
      const fixture = await createFixture();
      await beginAnchorAttempt(prisma, {
        purchaseId: fixture.purchaseId,
        kind: "AUTHORIZE",
        contractAddress: CONTRACT_ADDRESS,
        requestId: "attempt-ok",
      });
      const confirmation = {
        purchaseId: fixture.purchaseId,
        kind: "AUTHORIZE" as const,
        result: { transactionHash: TX_HASH, blockNumber: 123n },
        confirmedAt: NOW,
        reconciled: false,
        anchorExplorerBase: "https://sepolia.basescan.org",
      };

      await expect(
        confirmAnchorState(prisma, { ...confirmation, requestId: INVALID_REQUEST_ID }),
      ).rejects.toThrow();
      const [rolledBackAnchor, rolledBackPurchase] = await Promise.all([
        prisma.onchainAnchor.findUniqueOrThrow({
          where: { purchaseId_kind: { purchaseId: fixture.purchaseId, kind: "AUTHORIZE" } },
        }),
        prisma.purchase.findUniqueOrThrow({ where: { id: fixture.purchaseId } }),
      ]);
      expect(rolledBackAnchor).toMatchObject({ status: "PENDING", confirmedAt: null });
      expect(rolledBackPurchase).toMatchObject({
        status: "AUTH_ANCHOR_PENDING",
        anchorExplorerBase: null,
      });

      await confirmAnchorState(prisma, { ...confirmation, requestId: "confirm-ok" });
      await expect(
        confirmAnchorState(prisma, { ...confirmation, requestId: "confirm-race" }),
      ).rejects.toMatchObject({ code: "CONTRACT_ANCHOR_FAILED", statusCode: 409 });
      const [anchor, purchase, confirmedEvents] = await Promise.all([
        prisma.onchainAnchor.findUniqueOrThrow({
          where: { purchaseId_kind: { purchaseId: fixture.purchaseId, kind: "AUTHORIZE" } },
        }),
        prisma.purchase.findUniqueOrThrow({ where: { id: fixture.purchaseId } }),
        prisma.auditEvent.count({
          where: {
            purchaseId: fixture.purchaseId,
            eventType: "AUTHORIZATION_ANCHOR_CONFIRMED",
          },
        }),
      ]);
      expect(anchor).toMatchObject({
        status: "CONFIRMED",
        transactionHash: TX_HASH,
        blockNumber: 123n,
      });
      expect(purchase).toMatchObject({
        status: "AUTHORIZED",
        anchorExplorerBase: "https://sepolia.basescan.org",
      });
      expect(confirmedEvents).toBe(1);
    });

    it("atomically CAS-transitions Task and Purchase with exactly one audit event", async () => {
      const fixture = await createFixture();
      await Promise.all([
        prisma.task.update({ where: { id: fixture.taskId }, data: { status: "PAYING" } }),
        prisma.purchase.update({
          where: { id: fixture.purchaseId },
          data: { status: "PAYING" },
        }),
      ]);
      const transition = (requestId: string) =>
        prisma.$transaction((transaction) =>
          transitionPurchaseWorkflowStage(transaction, {
            taskId: fixture.taskId,
            purchaseId: fixture.purchaseId,
            paymentId: fixture.paymentId,
            sellerId: fixture.sellerId,
            requestId,
            expectedTaskStatuses: ["PAYING"],
            expectedPurchaseStatuses: ["PAYING"],
            nextTaskStatus: "DELIVERING",
            nextPurchaseStatus: "DELIVERED",
            aggregateType: "PURCHASE",
            aggregateId: fixture.purchaseId,
            stage: "DELIVERING",
            eventType: "DELIVERY_STAGE_ENTERED",
            payload: { previousStatus: "PAYING" },
          }),
        );

      await expect(transition(INVALID_REQUEST_ID)).rejects.toThrow();
      const [rolledBackTask, rolledBackPurchase] = await Promise.all([
        prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } }),
        prisma.purchase.findUniqueOrThrow({ where: { id: fixture.purchaseId } }),
      ]);
      expect(rolledBackTask.status).toBe("PAYING");
      expect(rolledBackPurchase.status).toBe("PAYING");

      const outcomes = await Promise.allSettled([transition("delivery-race-a"), transition("delivery-race-b")]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      const [task, purchase, events] = await Promise.all([
        prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } }),
        prisma.purchase.findUniqueOrThrow({ where: { id: fixture.purchaseId } }),
        prisma.auditEvent.count({
          where: { purchaseId: fixture.purchaseId, eventType: "DELIVERY_STAGE_ENTERED" },
        }),
      ]);
      expect(task.status).toBe("DELIVERING");
      expect(purchase.status).toBe("DELIVERED");
      expect(events).toBe(1);
    });
  },
);
