import { randomUUID } from "node:crypto";
import { prisma } from "@mello/db";
import { BASE_SEPOLIA_USDC, MELLO_NETWORK, type ServiceRecord } from "@mello/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ProcurementControls } from "./procurement-controls.js";

const controls = new ProcurementControls(prisma);
const taskIds = new Set<string>();
const service: ServiceRecord = { id: "credit-report-b", sellerId: "seller-b", sellerLegalName: "Demo Seller", sellerBusinessId: "12345675",
  payToAddress: "0x2222222222222222222222222222222222222222", invoiceCapability: "TW_B2B_DEMO", invoiceProvider: "MOCK",
  category: "credit_report", endpoint: "http://127.0.0.1:4412/v1/credit-report", method: "POST", priceAtomic: "50000",
  tokenSymbol: "USDC", tokenAddress: BASE_SEPOLIA_USDC, tokenDecimals: 6, network: MELLO_NETWORK, supportsTwInvoice: true, active: true };

async function fixture(extra: { approvalLimitAtomic?: string; expectedPayTo?: string } = {}) {
  const task = await controls.createTask({ prompt: "幫我買一份 晨光貿易 的信用報告，預算 0.10 USDC，要開統編發票。", requestKey: randomUUID(), ...extra });
  taskIds.add(task.id);
  await prisma.task.update({ where: { id: task.id }, data: { status: "EVALUATING" } });
  return task.id;
}

describe.skipIf(process.env["RUN_INTEGRATION_TESTS"] !== "true").sequential("console procurement controls", () => {
  beforeEach(async () => { await controls.setFrozen(false); });
  afterAll(async () => {
    await controls.setFrozen(false);
    await prisma.auditEvent.deleteMany({ where: { taskId: { in: [...taskIds] } } });
    await prisma.task.deleteMany({ where: { id: { in: [...taskIds] } } });
    await prisma.$disconnect();
  });

  it("collapses concurrent agent submissions to one task and rejects content/key conflicts", async () => {
    const input = { requestKey: randomUUID(), prompt: "採購信用報告，預算 0.10 USDC" };
    const results = await Promise.all(Array.from({ length: 8 }, () => controls.createTask(input)));
    results.forEach(result => taskIds.add(result.id));
    expect(new Set(results.map(result => result.id)).size).toBe(1);
    expect(results.filter(result => !result.deduplicated)).toHaveLength(1);
    await expect(controls.createTask({ ...input, prompt: "不同的信用報告，預算 0.10 USDC" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("pauses before payment, binds approval to exact terms, and requires a fresh approval after a quote change", async () => {
    const id = await fixture({ approvalLimitAtomic: "30000" });
    expect(await controls.assess(id, service)).toBe(false);
    expect(await prisma.task.findUnique({ where: { id } })).toMatchObject({ status: "ACTION_REQUIRED", errorCode: "APPROVAL_REQUIRED" });
    expect(await prisma.purchase.count({ where: { taskId: id } })).toBe(0);
    await controls.approve(id);
    expect(await controls.assess(id, service)).toBe(true);
    expect(await controls.assess(id, { ...service, priceAtomic: "60000" })).toBe(false);
    expect((await controls.detail(id))?.approvedAt).toBeNull();
  });

  it("takes the stricter prompt/structured approval threshold", async () => {
    const result = await controls.createTask({ requestKey: randomUUID(), prompt: "信用報告，預算 0.10 USDC，超過 0.03 USDC 先問我。", approvalLimitAtomic: "80000" });
    taskIds.add(result.id);
    expect((await controls.detail(result.id))?.approvalLimitAtomic).toBe("30000");
  });

  it("rejects a requested recipient mismatch before creating payment evidence", async () => {
    const id = await fixture({ expectedPayTo: "0x0000000000000000000000000000000000000001" });
    expect(await controls.assess(id, service)).toBe(false);
    expect(await prisma.task.findUnique({ where: { id } })).toMatchObject({ status: "REJECTED", errorMessage: expect.stringContaining("PAY_TO_MISMATCH") });
    expect(await prisma.purchase.count({ where: { taskId: id } })).toBe(0);
  });

  it("persists freeze across service instances and denies new submissions/releases until unfreezing", async () => {
    const id = await fixture();
    await controls.setFrozen(true);
    const restarted = new ProcurementControls(prisma);
    expect((await restarted.state()).paymentsFrozen).toBe(true);
    await expect(restarted.createTask({ prompt: "新採購信用報告", requestKey: randomUUID() })).rejects.toMatchObject({ code: "PAYMENTS_FROZEN" });
    await expect(restarted.assess(id, service)).rejects.toMatchObject({ code: "PAYMENTS_FROZEN" });
    await expect(restarted.claimPaymentRelease(id, randomUUID())).rejects.toMatchObject({ code: "PAYMENTS_FROZEN" });
    await restarted.setFrozen(false);
    expect(await restarted.assess(id, service)).toBe(true);
  });
});
