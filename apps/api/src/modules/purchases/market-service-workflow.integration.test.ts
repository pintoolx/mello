import { randomUUID } from "node:crypto";
import { prisma } from "@mello/db";
import { MockAuditAnchorClient } from "@mello/contracts-client";
import { MARKET_SERVICE_CATALOG } from "@mello/shared";
import { InMemoryIdempotencyStore, MOCK_PAYMENT_HEADER } from "@mello/seller-kit";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createSellerAApplication } from "../../../sellers/seller-a/app.js";
import { createSellerBApplication } from "../../../sellers/seller-b/app.js";
import { createApp } from "../../app.js";
import { createCoreApiDependencies } from "../../bootstrap.js";
import { loadConfig } from "../../config.js";
import { createRouteExtensions } from "../../seller-kit/protocol.js";
import { MockInvoiceAdapter } from "../invoices/index.js";
import { ProcurementAgent } from "../procurement-agent/agent.js";
import { BazaarResourceSchema } from "../service-registry/bazaar-client.js";
import { resultFixture, resourceFixture } from "../service-registry/fixtures.js";
import { LEGACY_CREDIT_SERVICE_IDS, registerMarketServiceCatalog } from "../service-registry/market-service-catalog.js";
import { normalizeRegistryService } from "../service-registry/registry-service.js";
import { MockPaymentProvider } from "../x402-buyer/index.js";

const SECRET = "market-workflow-fixture-context-secret-32";
const API_KEY = "market-workflow-fixture-access-token-32";
const marketIds = MARKET_SERVICE_CATALOG.map((entry) => entry.id);
const taskIds: string[] = [];
const aggregateIds = [...marketIds, ...LEGACY_CREDIT_SERVICE_IDS, "mello-market-service-catalog-v1"];
let originalServices: Awaited<ReturnType<typeof prisma.service.findMany>>;
let originalSellers: Awaited<ReturnType<typeof prisma.seller.findMany>>;
let originalPolicies: Awaited<ReturnType<typeof prisma.policy.findMany>>;
let originalControl: Awaited<ReturnType<typeof prisma.paymentControl.findUnique>>;
let originalAuditIds: string[];

describe.sequential("service-first market workflow (isolated PostgreSQL, synthetic Bazaar and payments)", () => {
  beforeEach(async () => {
    // The integration runner enforces an approved, dedicated test database.
    // Never seed/reset a database here; restore only these exact fixture rows.
    originalServices = await prisma.service.findMany({ where: { id: { in: [...LEGACY_CREDIT_SERVICE_IDS] } } });
    originalSellers = await prisma.seller.findMany({ where: { id: { in: ["seller-a", "seller-b"] } } });
    originalPolicies = await prisma.policy.findMany({ where: { active: true } });
    originalControl = await prisma.paymentControl.findUnique({ where: { id: "global" } });
    originalAuditIds = (await prisma.auditEvent.findMany({ where: { aggregateId: { in: aggregateIds } }, select: { id: true } })).map((event) => event.id);
    expect(await prisma.service.count({ where: { id: { in: marketIds } } })).toBe(0);
    for (const sellerId of ["seller-a", "seller-b"]) {
      await prisma.service.updateMany({ where: { id: { in: [...LEGACY_CREDIT_SERVICE_IDS] }, sellerId },
        data: { endpoint: `https://${sellerId}.example.com/v1/credit-report` } });
    }
    await prisma.policy.updateMany({ where: { id: { in: originalPolicies.map((policy) => policy.id) } }, data: { requireTwInvoice: false } });
    await prisma.paymentControl.upsert({ where: { id: "global" }, create: { id: "global", paymentsFrozen: false }, update: { paymentsFrozen: false } });
    const registration = await registerMarketServiceCatalog(prisma);
    expect(registration.created.sort()).toEqual([...marketIds].sort());
  });

  afterEach(async () => {
    await prisma.workflowJob.deleteMany({ where: { aggregateId: { in: taskIds } } });
    await prisma.auditEvent.deleteMany({ where: { OR: [
      { taskId: { in: taskIds } },
      { aggregateId: { in: aggregateIds }, id: { notIn: originalAuditIds } },
    ] } });
    await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    await prisma.service.deleteMany({ where: { id: { in: marketIds } } });
    for (const { id, ...data } of originalServices) await prisma.service.update({ where: { id }, data });
    for (const { id, ...data } of originalSellers) await prisma.seller.update({ where: { id }, data });
    for (const { id, requireTwInvoice } of originalPolicies) await prisma.policy.update({ where: { id }, data: { requireTwInvoice } });
    if (originalControl) {
      const { id, ...data } = originalControl;
      await prisma.paymentControl.update({ where: { id }, data });
    } else await prisma.paymentControl.delete({ where: { id: "global" } });
    taskIds.splice(0);
  });
  afterAll(async () => prisma.$disconnect());

  it.each(MARKET_SERVICE_CATALOG)("discovers and purchases $id only after human selection, with its real Demo report", async (offering) => {
    const records = await prisma.service.findMany({ where: { id: { in: marketIds } }, include: { seller: true } });
    const services = records.map(normalizeRegistryService);
    const sellers = [createSellerAApplication, createSellerBApplication].map((create, index) => {
      const sellerId = index === 0 ? "seller-a" : "seller-b";
      const service = services.find((item) => item.sellerId === sellerId)!;
      return create({ paymentMode: "mock", publicUrl: `https://${sellerId}.example.com`,
        payToAddress: service.payToAddress, purchaseContextHmacSecret: SECRET,
      }, { idempotencyStore: new InMemoryIdempotencyStore() });
    });
    const resources = services.map((service) => {
      const seller = sellers.find((item) => item.config.sellerId === service.sellerId)!;
      // Build the exact live declaration, but enrich method like x402 Express.
      const extensions = createRouteExtensions({ ...seller.config, bazaarEnabled: true });
      const bazaar = extensions["bazaar"] as { info: { input: Record<string, unknown> }; schema: unknown };
      return BazaarResourceSchema.parse({ ...resourceFixture(service), extensions: {
        bazaar: { ...bazaar, info: { ...bazaar.info, input: { ...bazaar.info.input, method: "POST" } } },
      } });
    });
    const search = vi.fn(async () => ({ ...resultFixture(resources), fetchedAt: new Date().toISOString() }));
    let paidRequests = 0;
    const transport = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      const seller = sellers.find((item) => new URL(req.url).origin === item.config.publicUrl);
      if (!seller) throw new Error("External transport is prohibited in this fixture");
      if (req.headers.has(MOCK_PAYMENT_HEADER)) paidRequests++;
      const result = await request(seller.app).post(new URL(req.url).pathname)
        .set(Object.fromEntries(req.headers)).send(await req.json());
      return new Response(JSON.stringify(result.body), { status: result.status, headers: result.headers as Record<string, string> });
    });
    const paymentProvider = new MockPaymentProvider(undefined, () => new Date(), transport);
    const prepare = vi.spyOn(paymentProvider, "prepare");
    const invoiceAdapter = new MockInvoiceAdapter(false);
    const issue = vi.spyOn(invoiceAdapter, "issue");
    const dependencies = createCoreApiDependencies({ prisma, agent: new ProcurementAgent({ mode: "demo" }),
      config: loadConfig({ DATABASE_URL: process.env["DATABASE_URL"], SERVICE_DISCOVERY_MODE: "bazaar", PAYMENT_MODE: "mock",
        CONTRACT_ANCHOR_MODE: "mock", AGENT_MODE: "demo", INVOICE_PROVIDER: "mock", SELLER_CONTEXT_HMAC_SECRET: SECRET,
        API_ACCESS_TOKEN: API_KEY, DEMO_ADMIN_TOKEN: "market-workflow-fixture-admin" }),
      bazaar: { search }, paymentProvider, invoiceAdapter, anchorClient: new MockAuditAnchorClient(),
      logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
    });
    const app = createApp(dependencies);
    const post = (path: string) => request(app).post(`/api/v1${path}`).set("x-mello-api-key", API_KEY);
    const get = (path: string) => request(app).get(`/api/v1${path}`).set("x-mello-api-key", API_KEY);
    const created = await post("/tasks").send({
      prompt: `搜尋服務：${offering.displayName}\n預算：0.1 USDC\n${offering.supportsTwInvoice ? "需要統編發票" : "不需要發票"}`,
      requestKey: randomUUID(), requirements: { requiresTwInvoice: offering.supportsTwInvoice, requiresRegistryCertification: false },
    }).expect(201);
    const taskId = String(created.body.taskId);
    taskIds.push(taskId);
    await post(`/tasks/${taskId}/discover`).expect(202);
    await dependencies.workflowJobPoller.runOnce();
    const surveyed = (await get(`/tasks/${taskId}`).expect(200)).body;
    expect(surveyed).toMatchObject({ status: "WAITING_SELECTION", purchase: null,
      intent: { serviceCategory: offering.category, serviceQuery: offering.displayName, usedDemoDefaultTarget: false } });
    expect(surveyed.intent).not.toHaveProperty("targetCompanyName");
    expect(prepare).not.toHaveBeenCalled();
    expect(paidRequests).toBe(0);
    expect(await prisma.payment.count({ where: { purchase: { taskId } } })).toBe(0);
    expect(await prisma.onchainAnchor.count({ where: { purchase: { taskId } } })).toBe(0);
    const eligible = surveyed.candidates.filter((item: { eligible: boolean }) => item.eligible);
    expect(eligible).toHaveLength(1);
    const selected = eligible[0];
    expect(selected).toMatchObject({ serviceId: offering.id, sellerDisplayName: offering.sellerDisplayName, displayName: offering.displayName });
    const wrong = MARKET_SERVICE_CATALOG.find((entry) => entry.id !== offering.id)!;
    await post(`/tasks/${taskId}/select`).send({ serviceId: wrong.id, selectionHash: selected.selectionHash }).expect(409);
    expect(prepare).not.toHaveBeenCalled();
    await post(`/tasks/${taskId}/select`).send({ serviceId: selected.serviceId, selectionHash: selected.selectionHash }).expect(202);
    await dependencies.workflowJobPoller.runOnce();
    const complete = (await get(`/tasks/${taskId}`).expect(200)).body;
    expect(complete.status).toBe("COMPLETED");
    expect(complete.purchase.selectedService.id).toBe(offering.id);
    expect(complete.purchase.payment.status).toBe("SETTLED");
    expect(complete.purchase.delivery).toMatchObject({ status: "DELIVERED", responseBody: {
      reportVersion: "market-v1", serviceId: offering.id, serviceCategory: offering.category,
      serviceQuery: offering.displayName, provider: offering.sellerId, title: offering.displayName, isDemo: true,
    } });
    expect(JSON.stringify(complete.purchase.delivery.responseBody)).not.toContain("Example Co.");
    expect(prepare).toHaveBeenCalledOnce();
    expect(paidRequests).toBe(1);
    expect(complete.purchase.invoice.status).toBe(offering.supportsTwInvoice ? "ISSUED_DEMO" : "NOT_REQUIRED");
    if (offering.supportsTwInvoice) {
      expect(issue).toHaveBeenCalledOnce();
      expect(issue.mock.calls[0]?.[0].itemName).toBe(offering.displayName);
    } else expect(issue).not.toHaveBeenCalled();
    await post(`/tasks/${taskId}/select`).send({ serviceId: selected.serviceId, selectionHash: selected.selectionHash }).expect(200);
    expect(await dependencies.workflowJobPoller.runOnce()).toBe(false);
    expect(paidRequests).toBe(1);
  });
});
