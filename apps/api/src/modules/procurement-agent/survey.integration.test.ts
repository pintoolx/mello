import { randomUUID } from "node:crypto";
import { prisma } from "@mello/db";
import { MockAuditAnchorClient } from "@mello/contracts-client";
import { InMemoryIdempotencyStore, MOCK_PAYMENT_HEADER } from "@mello/seller-kit";
import { type TaskRequirements } from "@mello/shared";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createSellerBApplication } from "../../../sellers/seller-b/app.js";
import { createApp } from "../../app.js";
import { createCoreApiDependencies } from "../../bootstrap.js";
import { loadConfig } from "../../config.js";
import { MockInvoiceAdapter } from "../invoices/index.js";
import { MockPaymentProvider } from "../x402-buyer/index.js";
import { ProcurementAgent } from "./agent.js";
import { normalizeRegistryService } from "../service-registry/registry-service.js";
import { resourceFixture, resultFixture } from "../service-registry/fixtures.js";
import { serviceBindingHash } from "../service-registry/verification.js";

const taskIds: string[] = [];
const serviceIds: string[] = [];
const SECRET = "survey-local-test-context-secret-at-least-32";
const API_KEY = "survey-local-test-access-token-at-least-32";
const ADMIN = "survey-local-test-admin-token";
const PROMPT = "幫我買一份 Example Co. 的信用報告，預算 0.1 USDC，要開統編發票。";

async function harness(mode: "bazaar" | "local_demo" = "bazaar") {
  await prisma.policy.updateMany({ where: { active: true }, data: { requireTwInvoice: false } });
  await prisma.paymentControl.upsert({ where: { id: "global" }, create: { id: "global", paymentsFrozen: false }, update: { paymentsFrozen: false } });
  const seed = await prisma.service.findUniqueOrThrow({ where: { id: "credit-report-b" } });
  const record = await prisma.service.create({ data: { ...seed, id: `survey-${randomUUID()}`,
    endpoint: "https://seller-b.example.com/v1/credit-report" }, include: { seller: true } });
  serviceIds.push(record.id);
  const service = normalizeRegistryService(record);
  const seller = createSellerBApplication({ paymentMode: "mock", publicUrl: "https://seller-b.example.com",
    payToAddress: service.payToAddress, purchaseContextHmacSecret: SECRET,
  }, { idempotencyStore: new InMemoryIdempotencyStore() });
  let paidRequests = 0;
  const transport = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    if (req.headers.has(MOCK_PAYMENT_HEADER)) paidRequests++;
    const result = await request(seller.app).post(new URL(req.url).pathname).set(Object.fromEntries(req.headers)).send(await req.json());
    return new Response(JSON.stringify(result.body), { status: result.status, headers: result.headers as Record<string, string> });
  });
  const provider = new MockPaymentProvider(undefined, () => new Date(), transport);
  const prepare = vi.spyOn(provider, "prepare");
  const agent = new ProcurementAgent({ mode: "demo" });
  const parse = vi.spyOn(agent, "parse");
  const search = vi.fn().mockResolvedValue(resultFixture([resourceFixture(service)]));
  const dependencies = createCoreApiDependencies({ prisma, agent,
    config: loadConfig({ DATABASE_URL: process.env["DATABASE_URL"], SERVICE_DISCOVERY_MODE: mode,
      PAYMENT_MODE: "mock", CONTRACT_ANCHOR_MODE: "mock", AGENT_MODE: "demo", INVOICE_PROVIDER: "mock",
      SELLER_CONTEXT_HMAC_SECRET: SECRET, API_ACCESS_TOKEN: API_KEY, DEMO_ADMIN_TOKEN: ADMIN }),
    bazaar: { search }, paymentProvider: provider, invoiceAdapter: new MockInvoiceAdapter(false), anchorClient: new MockAuditAnchorClient(),
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
  });
  const app = createApp(dependencies);
  const post = (path: string) => request(app).post(`/api/v1${path}`).set("x-mello-api-key", API_KEY);
  const get = (path: string) => request(app).get(`/api/v1${path}`).set("x-mello-api-key", API_KEY);
  async function create(requirements: TaskRequirements) {
    const input = { prompt: PROMPT, requestKey: randomUUID(), requirements };
    const result = await post("/tasks").send(input).expect(201);
    expect(result.body).toMatchObject({ status: "CREATED", discoveryQueued: true });
    const id: string = result.body.taskId;
    taskIds.push(id);
    return { id, input };
  }
  async function survey(requirements: TaskRequirements) {
    const { id, input } = await create(requirements);
    await dependencies.workflowJobPoller.runOnce();
    const result = await get(`/tasks/${id}`).expect(200);
    expect(result.body.status).toBe("WAITING_SELECTION");
    expect(result.body.purchase).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
    return { id, input, task: result.body };
  }
  async function certify() {
    await dependencies.registry!.verify(service.id, { expectedBindingHash: serviceBindingHash(service),
      scopes: ["ENDPOINT_CONTROL", "PAYMENT_WALLET_CONTROL", "DEMO_INVOICE_INTEGRATION"],
      evidenceRef: "test:survey-manual-review", expiresAt: new Date(Date.now() + 86400_000).toISOString() });
  }
  return { dependencies, service, prepare, parse, paidRequests: () => paidRequests, search, post, get, create, survey, certify };
}

describe.sequential("survey before human-confirmed procurement", () => {
  afterEach(async () => {
    await prisma.workflowJob.deleteMany({ where: { aggregateId: { in: taskIds } } });
    await prisma.auditEvent.deleteMany({ where: { OR: [{ taskId: { in: taskIds } }, { aggregateId: { in: serviceIds } }] } });
    await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    await prisma.service.deleteMany({ where: { id: { in: serviceIds } } });
    await prisma.policy.updateMany({ where: { active: true }, data: { requireTwInvoice: true } });
    taskIds.splice(0); serviceIds.splice(0);
  });
  afterAll(async () => prisma.$disconnect());

  it("persists requirements, deduplicates a lost create response, and rejects changed requirements", async () => {
    const h = await harness();
    const { id, input } = await h.create({ requiresTwInvoice: false, requiresRegistryCertification: false });
    expect((await h.post("/tasks").send(input).expect(200)).body).toMatchObject({ taskId: id, discoveryQueued: false });
    expect(await prisma.workflowJob.count({ where: { aggregateId: id, kind: "DISCOVER_TASK" } })).toBe(1);
    await h.post("/tasks").send({ ...input, requirements: { ...input.requirements, requiresTwInvoice: true } }).expect(409);
    expect((await h.get(`/tasks/${id}`).expect(200)).body.control.requirements).toEqual(input.requirements);
    await h.post(`/tasks/${id}/select`).send({ serviceId: h.service.id }).expect(400);
    expect(h.prepare).not.toHaveBeenCalled();
  });

  it("replays a completed discovery harmlessly and preserves selection after a late discovery failure", async () => {
    const h = await harness();
    const { id, task } = await h.survey({ requiresTwInvoice: false, requiresRegistryCertification: false });
    const job = await prisma.workflowJob.findFirstOrThrow({ where: { aggregateId: id, kind: "DISCOVER_TASK" } });
    await h.dependencies.workflow.discover(id, "recovered-response", job.id);
    await h.dependencies.repository.recordBackgroundFailure({ operation: "DISCOVER_TASK", taskId: id, jobId: job.id,
      requestId: "late-error", error: new Error("worker lost successful response") });
    expect((await h.get(`/tasks/${id}`).expect(200)).body).toMatchObject({ status: "WAITING_SELECTION", purchase: null });
    const candidate = task.candidates.find((item: { serviceId: string }) => item.serviceId === h.service.id);
    const selection = { serviceId: candidate.serviceId, selectionHash: candidate.selectionHash };
    await h.post(`/tasks/${id}/select`).send(selection).expect(202);
    await h.dependencies.workflow.discover(id, "late-discovery-replay", job.id);
    await h.dependencies.repository.recordBackgroundFailure({ operation: "DISCOVER_TASK", taskId: id, jobId: job.id,
      requestId: "late-selected-error", error: new Error("stale discovery failed") });
    expect((await h.get(`/tasks/${id}`).expect(200)).body).toMatchObject({ status: "CREATED", purchase: null, control: { selectedService: selection } });
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.paidRequests()).toBe(0);
  });

  it("does not let a prior generation's final error overwrite a newly queued discovery", async () => {
    const h = await harness();
    const { id } = await h.create({ requiresTwInvoice: false, requiresRegistryCertification: false });
    h.search.mockRejectedValueOnce(new Error("catalog unavailable"));
    await h.dependencies.workflowJobPoller.runOnce();
    const previous = await prisma.workflowJob.findFirstOrThrow({ where: { aggregateId: id, kind: "DISCOVER_TASK" } });
    await h.post(`/tasks/${id}/discover`).expect(202);
    const current = await prisma.taskControl.findUniqueOrThrow({ where: { taskId: id } });
    expect(current.discoveryJobId).not.toBe(previous.id);
    await h.dependencies.repository.recordBackgroundFailure({ operation: "DISCOVER_TASK", taskId: id, jobId: previous.id,
      requestId: "late-prior-generation-error", error: new Error("old worker failed late") });
    expect((await h.get(`/tasks/${id}`).expect(200)).body).toMatchObject({ status: "CREATED", purchase: null });
    await h.dependencies.workflowJobPoller.runOnce();
    expect((await h.get(`/tasks/${id}`).expect(200)).body).toMatchObject({ status: "WAITING_SELECTION", purchase: null });
    expect(h.prepare).not.toHaveBeenCalled();
  });

  it.each(["bazaar", "local_demo"] as const)("stops before payment and pays only the human-selected service in %s", async (mode) => {
    const h = await harness(mode);
    const { id, task } = await h.survey({ requiresTwInvoice: false, requiresRegistryCertification: false });
    expect(task.intent.requiresTwInvoice).toBe(false); // Explicit unchecked choice beats invoice prose.
    const candidate = task.candidates.find((item: { serviceId: string }) => item.serviceId === h.service.id);
    expect(candidate).toMatchObject({ eligible: true, verificationStatus: "UNREVIEWED", matchesRequirements: true });
    await h.post(`/tasks/${id}/run`).expect(409);
    const selection = { serviceId: candidate.serviceId, selectionHash: candidate.selectionHash };
    await h.post(`/tasks/${id}/select`).send({ ...selection, serviceId: "forged-service" }).expect(409);
    await h.post(`/tasks/${id}/select`).send(selection).expect(202);
    await h.post(`/tasks/${id}/select`).send(selection).expect(200);
    await h.dependencies.workflowJobPoller.runOnce();
    const complete = (await h.get(`/tasks/${id}`).expect(200)).body;
    expect(complete.status).toBe("COMPLETED");
    expect(complete.purchase.selectedService.id).toBe(h.service.id);
    expect(complete.purchase.invoice.status).toBe("NOT_REQUIRED");
    expect(h.prepare).toHaveBeenCalledOnce();
    expect(h.parse).toHaveBeenCalledOnce();
    expect(h.paidRequests()).toBe(1);
    await h.post(`/tasks/${id}/select`).send(selection).expect(200);
    expect(await h.dependencies.workflowJobPoller.runOnce()).toBe(false);
    expect(h.paidRequests()).toBe(1);
  });

  it("keeps required certification separate from listing and completes a certified invoice purchase", async () => {
    const h = await harness();
    const { id } = await h.survey({ requiresTwInvoice: true, requiresRegistryCertification: true });
    await h.certify();
    await h.post(`/tasks/${id}/discover`).expect(202);
    await h.dependencies.workflowJobPoller.runOnce();
    const task = (await h.get(`/tasks/${id}`).expect(200)).body;
    const visible = task.candidates.filter((item: { matchesRequirements: boolean }) => item.matchesRequirements);
    expect(visible).toHaveLength(1);
    const candidate = visible[0];
    await h.post(`/tasks/${id}/select`).send({ serviceId: candidate.serviceId, selectionHash: candidate.selectionHash }).expect(202);
    await h.dependencies.workflowJobPoller.runOnce();
    const complete = (await h.get(`/tasks/${id}`).expect(200)).body;
    expect(complete.status).toBe("COMPLETED");
    expect(complete.purchase.invoice.status).toBe("ISSUED_DEMO");
  });

  it.each(["price", "certification"])("returns to selection when %s changes after confirmation", async (change) => {
    const h = await harness();
    await h.certify();
    const { id, task } = await h.survey({ requiresTwInvoice: true, requiresRegistryCertification: true });
    const candidate = task.candidates.find((item: { serviceId: string }) => item.serviceId === h.service.id);
    await h.post(`/tasks/${id}/select`).send({ serviceId: candidate.serviceId, selectionHash: candidate.selectionHash }).expect(202);
    if (change === "price") await prisma.service.update({ where: { id: h.service.id }, data: { priceAtomic: "60000" } });
    else await h.dependencies.registry!.revoke(h.service.id, "test:review-expired-after-selection");
    await h.dependencies.workflowJobPoller.runOnce();
    const updated = (await h.get(`/tasks/${id}`).expect(200)).body;
    expect(updated).toMatchObject({ status: "WAITING_SELECTION", purchase: null, control: { selectedService: null } });
    expect(h.prepare).not.toHaveBeenCalled();
  });

  it("retries a failed survey on the same task without releasing payment", async () => {
    const h = await harness();
    const { id } = await h.create({ requiresTwInvoice: false, requiresRegistryCertification: false });
    h.search.mockRejectedValueOnce(new Error("catalog unavailable"));
    await h.dependencies.workflowJobPoller.runOnce();
    expect((await h.get(`/tasks/${id}`).expect(200)).body.status).toBe("FAILED");
    await h.post(`/tasks/${id}/discover`).expect(202);
    await h.dependencies.workflowJobPoller.runOnce();
    expect((await h.get(`/tasks/${id}`).expect(200)).body).toMatchObject({ status: "WAITING_SELECTION", purchase: null });
    expect(h.prepare).not.toHaveBeenCalled();
  });

  it("rolls selection back if durable dispatch fails", async () => {
    const h = await harness();
    const { id, task } = await h.survey({ requiresTwInvoice: false, requiresRegistryCertification: false });
    const candidate = task.candidates.find((item: { serviceId: string }) => item.serviceId === h.service.id);
    await expect(h.dependencies.controls!.selectService(id,
      { serviceId: candidate.serviceId, selectionHash: candidate.selectionHash },
      async () => { throw new Error("queue unavailable"); })).rejects.toThrow("queue unavailable");
    expect((await h.get(`/tasks/${id}`).expect(200)).body).toMatchObject({
      status: "WAITING_SELECTION", purchase: null, control: { selectedService: null },
    });
    expect(h.prepare).not.toHaveBeenCalled();
  });

  it("can survey again after a selected service recheck fails, requiring a new human choice", async () => {
    const h = await harness();
    const { id, task } = await h.survey({ requiresTwInvoice: false, requiresRegistryCertification: false });
    const candidate = task.candidates.find((item: { serviceId: string }) => item.serviceId === h.service.id);
    await h.post(`/tasks/${id}/select`).send({ serviceId: candidate.serviceId, selectionHash: candidate.selectionHash }).expect(202);
    h.search.mockRejectedValueOnce(new Error("catalog unavailable after selection"));
    await h.dependencies.workflowJobPoller.runOnce();
    expect((await h.get(`/tasks/${id}`).expect(200)).body.status).toBe("FAILED");
    await h.post(`/tasks/${id}/discover`).expect(202);
    await h.dependencies.workflowJobPoller.runOnce();
    expect((await h.get(`/tasks/${id}`).expect(200)).body).toMatchObject({
      status: "WAITING_SELECTION", purchase: null, control: { selectedService: null },
    });
    expect(h.prepare).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent human submissions into one durable payment job", async () => {
    const h = await harness();
    const { id, task } = await h.survey({ requiresTwInvoice: false, requiresRegistryCertification: false });
    const candidate = task.candidates.find((item: { serviceId: string }) => item.serviceId === h.service.id);
    const selection = { serviceId: candidate.serviceId, selectionHash: candidate.selectionHash };
    const results = await Promise.all(Array.from({ length: 4 }, () => h.post(`/tasks/${id}/select`).send(selection)));
    expect(results.map((result) => result.status).sort()).toEqual([200, 200, 200, 202]);
    expect(await prisma.workflowJob.count({ where: { aggregateId: id, status: "PENDING" } })).toBe(1);
    await h.dependencies.workflowJobPoller.runOnce();
    expect(h.prepare).toHaveBeenCalledOnce();
    expect(h.paidRequests()).toBe(1);
  });

  it("purchases a named unreviewed option through its existing invoice provider", async () => {
    const h = await harness();
    await h.certify();
    const source = await prisma.service.findUniqueOrThrow({ where: { id: h.service.id } });
    const option = await prisma.service.create({ data: {
      ...source, id: `survey-option-${randomUUID()}`, displayName: "Mello 信用報告 C（Demo）",
    } });
    serviceIds.push(option.id);
    const { id, task } = await h.survey({ requiresTwInvoice: true, requiresRegistryCertification: false });
    const candidate = task.candidates.find((item: { serviceId: string }) => item.serviceId === option.id);
    expect(candidate).toMatchObject({ displayName: option.displayName, eligible: true, verificationStatus: "UNREVIEWED", supportsTwInvoice: true });
    expect(task.candidates.find((item: { serviceId: string }) => item.serviceId === h.service.id).verificationStatus).toBe("VERIFIED");
    await h.post(`/tasks/${id}/select`).send({ serviceId: option.id, selectionHash: candidate.selectionHash }).expect(202);
    await h.dependencies.workflowJobPoller.runOnce();
    const complete = (await h.get(`/tasks/${id}`).expect(200)).body;
    expect(complete.status).toBe("COMPLETED");
    expect(complete.purchase.selectedService).toMatchObject({ id: option.id, displayName: option.displayName, sellerId: "seller-b" });
    expect(complete.purchase.invoice.status).toBe("ISSUED_DEMO");
    expect(h.paidRequests()).toBe(1);
    expect(await prisma.serviceVerification.findUnique({ where: { serviceId: option.id } })).toBeNull();
  });
});
