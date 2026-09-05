import { randomUUID } from "node:crypto";
import { prisma } from "@mello/db";
import { MockAuditAnchorClient } from "@mello/contracts-client";
import { InMemoryIdempotencyStore, MOCK_PAYMENT_HEADER } from "@mello/seller-kit";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createSellerBApplication } from "../../../sellers/seller-b/app.js";
import { createApp } from "../../app.js";
import { createCoreApiDependencies } from "../../bootstrap.js";
import { loadConfig } from "../../config.js";
import { MockInvoiceAdapter } from "../invoices/index.js";
import { ProcurementAgent } from "../procurement-agent/index.js";
import { PurchaseWorkflow } from "../purchases/purchase-workflow.js";
import { MockPaymentProvider } from "../x402-buyer/index.js";
import { ServiceRegistry, normalizeRegistryService } from "./registry-service.js";
import { resourceFixture, resultFixture } from "./fixtures.js";
import { serviceBindingHash, type VerifyServiceInput } from "./verification.js";

const taskIds: string[] = [];
const serviceIds: string[] = [];
const SECRET = "local-integration-context-secret-at-least-32";
const API_KEY = "local-integration-api-token-at-least-32";
const ADMIN = "local-integration-admin-token";

async function harness(failInvoiceOnce = false) {
  const now = new Date();
  const serviceId = `bazaar-${randomUUID()}`;
  serviceIds.push(serviceId);
  const seed = await prisma.service.findUniqueOrThrow({ where: { id: "credit-report-b" } });
  const record = await prisma.service.create({ data: { ...seed, id: serviceId, endpoint: "https://seller-b.example.com/v1/credit-report" }, include: { seller: true } });
  const service = normalizeRegistryService(record);
  const search = vi.fn().mockResolvedValue(resultFixture([resourceFixture(service)]));
  const registry = new ServiceRegistry(prisma, { search }, () => now);
  const reviewInput: VerifyServiceInput = {
    expectedBindingHash: serviceBindingHash(service),
    scopes: ["ENDPOINT_CONTROL", "PAYMENT_WALLET_CONTROL", "DEMO_INVOICE_INTEGRATION"],
    evidenceRef: "test:manual-review-fixture", expiresAt: new Date(now.getTime() + 86400_000).toISOString(),
  };
  const seller = createSellerBApplication({
    paymentMode: "mock", publicUrl: "https://seller-b.example.com", payToAddress: service.payToAddress,
    purchaseContextHmacSecret: SECRET, clock: () => new Date(),
  }, { idempotencyStore: new InMemoryIdempotencyStore() });
  let paidRequests = 0;
  const transport = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    if (req.headers.has(MOCK_PAYMENT_HEADER)) paidRequests++;
    const res = await request(seller.app).post(new URL(req.url).pathname).set(Object.fromEntries(req.headers)).send(await req.json());
    return new Response(JSON.stringify(res.body), { status: res.status, headers: res.headers as Record<string, string> });
  });
  const provider = new MockPaymentProvider(undefined, () => new Date(), transport);
  const prepare = vi.spyOn(provider, "prepare");
  const config = loadConfig({ DATABASE_URL: process.env["DATABASE_URL"], SERVICE_DISCOVERY_MODE: "bazaar",
    SELLER_CONTEXT_HMAC_SECRET: SECRET, API_ACCESS_TOKEN: API_KEY, DEMO_ADMIN_TOKEN: ADMIN });
  const workflow = new PurchaseWorkflow({ prisma, config, registry, agent: new ProcurementAgent({ mode: "demo" }),
    paymentProvider: provider, invoiceAdapter: new MockInvoiceAdapter(failInvoiceOnce), anchorClient: new MockAuditAnchorClient(),
    logger: { error: vi.fn() } as never,
  });
  const taskId = randomUUID();
  taskIds.push(taskId);
  await prisma.task.create({ data: { id: taskId, prompt: "幫我買一份 Example Co. 的信用報告，預算 0.1 USDC，要開統編發票。" } });
  const task = () => prisma.task.findUniqueOrThrow({ where: { id: taskId }, include: { purchase: { include: { payment: true, invoice: true } } } });
  return { registry, search, reviewInput, service, workflow, taskId, task, provider, prepare, transport, paidRequests: () => paidRequests, config };
}

describe.sequential("Bazaar / Mello / policy procurement intersection", () => {
  afterEach(async () => {
    await prisma.auditEvent.deleteMany({ where: { OR: [{ taskId: { in: taskIds } }, { aggregateType: "SERVICE", aggregateId: { in: serviceIds } }] } });
    await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    await prisma.service.deleteMany({ where: { id: { in: serviceIds } } });
    taskIds.splice(0); serviceIds.splice(0);
  });
  afterAll(async () => prisma.$disconnect());

  it("does not treat ACTIVE, Bazaar listing or enterprise whitelist as verification", async () => {
    const h = await harness();
    await h.workflow.run(h.taskId);
    expect(await h.task()).toMatchObject({ status: "REJECTED", purchase: null });
    expect(h.prepare).not.toHaveBeenCalled();
  });
  it("does not fall back to local verified services when Bazaar is empty", async () => {
    const h = await harness();
    await h.registry.verify(h.service.id, h.reviewInput);
    h.search.mockResolvedValue(resultFixture([]));
    await h.workflow.run(h.taskId);
    expect(await h.task()).toMatchObject({ status: "REJECTED", purchase: null });
    expect(h.prepare).not.toHaveBeenCalled();
  });
  it("fails before contacting any seller when discovery is unavailable", async () => {
    const h = await harness();
    h.search.mockRejectedValue(new Error("catalog unavailable"));
    await expect(h.workflow.run(h.taskId)).rejects.toThrow("catalog unavailable");
    expect(h.prepare).not.toHaveBeenCalled();
    expect((await h.task()).purchase).toBeNull();
  });
  it("persists Bazaar evidence, settles once and retries only the Demo invoice", async () => {
    const h = await harness(true);
    await h.registry.verify(h.service.id, h.reviewInput);
    await h.workflow.run(h.taskId, "bazaar-integration");
    const initial = await h.task();
    expect(initial.status).toBe("ACTION_REQUIRED");
    expect(initial.purchase).toMatchObject({ discoveryEvidence: { source: "cdp_bazaar", verificationRevision: 1 }, payment: { status: "SETTLED" }, invoice: { status: "FAILED_RETRYABLE" } });
    const purchase = initial.purchase!;
    await h.registry.revoke(h.service.id, "test revocation after completed settlement");
    await h.workflow.retryInvoice(purchase.id);
    const done = await h.task();
    expect(done.status).toBe("COMPLETED");
    expect(done.purchase?.payment?.transactionHash).toBe(purchase.payment?.transactionHash);
    expect(h.prepare).toHaveBeenCalledOnce();
    expect(h.paidRequests()).toBe(1);
    expect(h.search.mock.calls.every(([input]) => !JSON.stringify(input).includes("Example Co."))).toBe(true);
  });
  it("blocks a revocation while the pre-sign discovery recheck is awaiting", async () => {
    const h = await harness();
    await h.registry.verify(h.service.id, h.reviewInput);
    h.search.mockResolvedValueOnce(resultFixture([resourceFixture(h.service)]));
    h.search.mockImplementationOnce(async () => {
      await h.registry.revoke(h.service.id, "revoked during discovery");
      return resultFixture([resourceFixture(h.service)]);
    });
    await expect(h.workflow.run(h.taskId)).rejects.toMatchObject({ code: "SERVICE_VERIFICATION_REQUIRED" });
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.paidRequests()).toBe(0);
  });
  it("blocks a revocation after signing but before releasing a paid request", async () => {
    const h = await harness();
    await h.registry.verify(h.service.id, h.reviewInput);
    const original = h.prepare.getMockImplementation() ?? MockPaymentProvider.prototype.prepare.bind(h.provider);
    h.prepare.mockImplementation(async (input) => {
      const prepared = await original(input);
      return { ...prepared, submit: async (hooks) => {
        await h.registry.revoke(h.service.id, "revoked before release");
        return prepared.submit(hooks);
      } };
    });
    await h.workflow.run(h.taskId);
    expect(h.paidRequests()).toBe(0);
    expect((await h.task()).purchase?.payment?.status).not.toBe("SETTLED");
  });
  it("cannot approve a changed binding, missing evidence scopes or expired review", async () => {
    const h = await harness();
    await expect(h.registry.verify(h.service.id, { ...h.reviewInput, expectedBindingHash: `0x${"00".repeat(32)}` })).rejects.toMatchObject({ code: "SERVICE_BINDING_CHANGED" });
    await expect(h.registry.verify(h.service.id, { ...h.reviewInput, expiresAt: "2020-01-01T00:00:00Z" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(h.registry.verify(h.service.id, { ...h.reviewInput, scopes: ["ENDPOINT_CONTROL", "PAYMENT_WALLET_CONTROL"] })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await prisma.serviceVerification.count({ where: { serviceId: h.service.id } })).toBe(0);
  });
  it("rechecks under the release lock even after the final catalog response was accepted", async () => {
    const h = await harness();
    await h.registry.verify(h.service.id, h.reviewInput);
    const release = h.registry.withPurchaseRelease.bind(h.registry);
    vi.spyOn(h.registry, "withPurchaseRelease").mockImplementationOnce(async (...args) => {
      await h.registry.revoke(h.service.id, "revocation between catalog check and release permit");
      return release(...args);
    });
    await h.workflow.run(h.taskId);
    expect(h.paidRequests()).toBe(0);
    expect((await h.task()).purchase?.payment?.status).not.toBe("SETTLED");
    expect(await prisma.auditEvent.count({ where: { taskId: h.taskId, eventType: "SERVICE_VERIFICATION_RELEASE_CHECKED" } })).toBe(0);
  });
  it("rolls back the verification release audit when the payment permit is refused", async () => {
    const h = await harness();
    await h.registry.verify(h.service.id, h.reviewInput);
    await h.workflow.run(h.taskId);
    const purchaseId = (await h.task()).purchase!.id;
    const count = await prisma.auditEvent.count({ where: { taskId: h.taskId, eventType: "SERVICE_VERIFICATION_RELEASE_CHECKED" } });
    expect(count).toBe(1);
    await expect(h.registry.withPurchaseRelease(purchaseId, true, async () => { throw new Error("permit refused"); })).rejects.toThrow("permit refused");
    expect(await prisma.auditEvent.count({ where: { taskId: h.taskId, eventType: "SERVICE_VERIFICATION_RELEASE_CHECKED" } })).toBe(count);
    expect(h.paidRequests()).toBe(1);
  });
  it("a verified Bazaar service still cannot bypass an enterprise seller whitelist", async () => {
    const h = await harness();
    await h.registry.verify(h.service.id, h.reviewInput);
    const policy = await prisma.policy.findFirstOrThrow({ where: { active: true } });
    try {
      await prisma.policy.update({ where: { id: policy.id }, data: { allowedSellerIds: ["seller-a"] } });
      await h.workflow.run(h.taskId);
      expect(await h.task()).toMatchObject({ status: "REJECTED", purchase: null });
      expect(h.prepare).not.toHaveBeenCalled();
    } finally {
      await prisma.policy.update({ where: { id: policy.id }, data: { allowedSellerIds: policy.allowedSellerIds! } });
    }
  });
  it("changing an endpoint invalidates its review and keeps a versioned audit trail", async () => {
    const h = await harness();
    await h.registry.verify(h.service.id, h.reviewInput);
    const updated = await h.registry.updateBinding(h.service.id, {
      expectedBindingHash: h.reviewInput.expectedBindingHash,
      endpoint: "https://seller-b.example.com/v2/credit-report", priceAtomic: "50000",
    });
    expect(updated.verification.status).toBe("BINDING_CHANGED");
    await h.workflow.run(h.taskId);
    expect(h.prepare).not.toHaveBeenCalled();
    expect(await prisma.auditEvent.count({ where: { aggregateType: "SERVICE", aggregateId: h.service.id, eventType: "SERVICE_BINDING_UPDATED" } })).toBe(1);
  });
  it("protects manual reviews with API + admin credentials and audits their revisions", async () => {
    const h = await harness();
    const app = createApp(createCoreApiDependencies({ prisma, config: h.config, bazaar: { search: h.search } }));
    const url = `/api/v1/registry/services/${h.service.id}`;
    await request(app).get("/api/v1/registry").expect(401);
    await request(app).post(`${url}/verify`).set("x-mello-api-key", API_KEY).send(h.reviewInput).expect(401);
    await request(app).post(`${url}/verify`).set("x-mello-api-key", API_KEY).set("x-demo-admin-token", ADMIN).send(h.reviewInput).expect(200);
    const revoked = await request(app).post(`${url}/revoke`).set("x-mello-api-key", API_KEY).set("x-demo-admin-token", ADMIN).send({ reason: "manual security review" }).expect(200);
    expect(revoked.body).toMatchObject({ status: "REVOKED", revision: 2 });
    expect(await prisma.auditEvent.count({ where: { aggregateType: "SERVICE", aggregateId: h.service.id } })).toBe(2);
  });
});
