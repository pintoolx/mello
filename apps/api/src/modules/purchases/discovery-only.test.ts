import { describe, expect, it, vi } from "vitest";
import { PurchaseWorkflow } from "./purchase-workflow.js";

const JOB_ID = "00000000-0000-4000-8000-000000000901";

describe("discovery-only workflow crash/replay boundary", () => {
  it.each([
    { status: "WAITING_SELECTION" }, { status: "FAILED" }, { status: "COMPLETED" },
    { purchase: { id: "purchase-id" } },
    { control: { discoveryJobId: JOB_ID, selectedService: { serviceId: "chosen" } } },
    { control: { discoveryJobId: JOB_ID, approvedAt: new Date() } },
    { control: { discoveryJobId: "newer-job" } },
  ])("does not reopen or purchase after persisted progress: %j", async (change) => {
    const task = { id: "task-id", status: "CREATED", purchase: null,
      control: { discoveryJobId: JOB_ID, selectedService: null, approvedAt: null,
        requirements: { requiresTwInvoice: false, requiresRegistryCertification: false } }, ...change };
    const tx = { $queryRaw: vi.fn(async () => []), task: { findUnique: vi.fn(async () => task), update: vi.fn() } };
    const agent = { parse: vi.fn() };
    const paymentProvider = { prepare: vi.fn(), getAddress: vi.fn() };
    const workflow = new PurchaseWorkflow({ prisma: { $transaction: (op: (transaction: typeof tx) => Promise<unknown>) => op(tx) },
      registry: {}, agent, paymentProvider, logger: { error: vi.fn() }, config: {} } as never);
    await expect(workflow.discover("task-id", "request-id", JOB_ID)).resolves.toBeUndefined();
    expect(tx.task.update).not.toHaveBeenCalled();
    expect(agent.parse).not.toHaveBeenCalled();
    expect(paymentProvider.prepare).not.toHaveBeenCalled();
    expect(paymentProvider.getAddress).not.toHaveBeenCalled();
  });
});
