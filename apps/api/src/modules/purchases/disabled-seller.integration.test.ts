import { randomUUID } from "node:crypto";
import { MockAuditAnchorClient } from "@mello/contracts-client";
import { prisma } from "@mello/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../config.js";
import { MockInvoiceAdapter } from "../invoices/index.js";
import { ProcurementAgent } from "../procurement-agent/index.js";
import type { PaymentProvider } from "../x402-buyer/index.js";
import { PurchaseWorkflow } from "./purchase-workflow.js";

const taskIds: string[] = [];

async function cleanup(): Promise<void> {
  if (taskIds.length > 0) {
    await prisma.auditEvent.deleteMany({ where: { taskId: { in: taskIds } } });
    await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    taskIds.splice(0, taskIds.length);
  }
  await prisma.seller.updateMany({
    where: { id: "seller-b" },
    data: { status: "ACTIVE" },
  });
}

describe.sequential("disabled Seller procurement boundary", () => {
  afterEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("never admits a disabled Seller into the candidate matrix", async () => {
    const taskId = randomUUID();
    taskIds.push(taskId);
    await prisma.seller.update({
      where: { id: "seller-b" },
      data: { status: "DISABLED" },
    });
    await prisma.task.create({
      data: {
        id: taskId,
        prompt:
          "幫我買一份 Example Co. 的信用報告，預算 0.1 USDC，要開統編發票。",
      },
    });

    const paymentProvider: PaymentProvider = {
      mode: "mock",
      getAddress: vi.fn(async () => {
        throw new Error("A rejected task must not request a buyer address");
      }),
      prepare: vi.fn(async () => {
        throw new Error("A rejected task must not prepare payment");
      }),
    };
    const workflow = new PurchaseWorkflow({
      prisma,
      config: loadConfig({
        DATABASE_URL: process.env["DATABASE_URL"] ?? "postgresql://invalid",
      }),
      agent: new ProcurementAgent({ mode: "demo" }),
      paymentProvider,
      invoiceAdapter: new MockInvoiceAdapter(false),
      anchorClient: new MockAuditAnchorClient(),
      logger: { error: vi.fn() } as never,
    });

    await workflow.run(taskId, "disabled-seller-test");

    const task = await prisma.task.findUniqueOrThrow({
      where: { id: taskId },
      include: { purchase: true },
    });
    const candidates = Array.isArray(task.candidates) ? task.candidates : [];
    expect(task.status).toBe("REJECTED");
    expect(task.purchase).toBeNull();
    expect(candidates).toEqual([
      expect.objectContaining({
        sellerId: "seller-a",
        eligible: false,
        reasonCodes: expect.arrayContaining(["INVOICE_UNSUPPORTED"]),
      }),
    ]);
    expect(paymentProvider.getAddress).not.toHaveBeenCalled();
    expect(paymentProvider.prepare).not.toHaveBeenCalled();
  });
});
