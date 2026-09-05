import { randomUUID } from "node:crypto";
import { prisma, type Prisma } from "@mello/db";
import { BASE_SEPOLIA_USDC, DEMO_COMPANY_ID, MARKET_SERVICE_CATALOG, MELLO_NETWORK } from "@mello/shared";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerDemoServiceOptions } from "./demo-service-options.js";
import { LEGACY_CREDIT_SERVICE_IDS, registerMarketServiceCatalog } from "./market-service-catalog.js";
import { normalizeRegistryService, ServiceRegistry } from "./registry-service.js";
import { resourceFixture, resultFixture } from "./fixtures.js";
import { serviceBindingHash } from "./verification.js";

const marketIds = MARKET_SERVICE_CATALOG.map((entry) => entry.id);
const aggregateIds = [...marketIds, ...LEGACY_CREDIT_SERVICE_IDS, "mello-market-service-catalog-v1"];
const hash = `0x${"1".repeat(64)}`;
let beforeServices: Awaited<ReturnType<typeof prisma.service.findMany>>;
let beforeSellers: Awaited<ReturnType<typeof prisma.seller.findMany>>;
let beforeAuditIds: string[];
const taskIds: string[] = [];
const jobIds: string[] = [];
const addedLegacyReviews: string[] = [];

async function completedPurchase() {
  const task = await prisma.task.create({ data: { prompt: "Historical credit report", status: "COMPLETED" } });
  taskIds.push(task.id);
  const paymentId = `market-history-${randomUUID()}`;
  const service = await prisma.service.findUniqueOrThrow({ where: { id: "credit-report-b" }, include: { seller: true } });
  return prisma.purchase.create({ data: {
    taskId: task.id, buyerProfileId: DEMO_COMPANY_ID, serviceId: service.id, paymentId,
    status: "COMPLETED", expectedAmountAtomic: service.priceAtomic, actualAmountAtomic: service.priceAtomic,
    network: MELLO_NETWORK, tokenSymbol: "USDC", tokenAddress: BASE_SEPOLIA_USDC, tokenDecimals: 6,
    buyerAddress: "0x9999999999999999999999999999999999999999", payToAddress: service.seller.payToAddress,
    policySnapshot: { preserved: true }, mandateHash: hash, policyHash: hash,
    expiresAt: new Date("2035-01-01T00:00:00Z"),
    payment: { create: { paymentId, status: "SETTLED", amountAtomic: service.priceAtomic, transactionHash: hash } },
    delivery: { create: { status: "DELIVERED", responseBody: { reportId: "original-credit-report", riskScore: 61 }, responseHash: hash } },
  } });
}

describe.sequential("guarded market catalog transition", () => {
  beforeEach(async () => {
    beforeServices = await prisma.service.findMany({ where: { id: { in: [...LEGACY_CREDIT_SERVICE_IDS] } } });
    beforeSellers = await prisma.seller.findMany({ where: { id: { in: ["seller-a", "seller-b"] } } });
    beforeAuditIds = (await prisma.auditEvent.findMany({ where: { aggregateId: { in: aggregateIds } }, select: { id: true } })).map((event) => event.id);
    expect(await prisma.service.count({ where: { id: { in: marketIds } } })).toBe(0);
  });
  afterEach(async () => {
    await prisma.workflowJob.deleteMany({ where: { id: { in: jobIds.splice(0) } } });
    await prisma.task.deleteMany({ where: { id: { in: taskIds.splice(0) } } });
    await prisma.auditEvent.deleteMany({ where: { aggregateId: { in: aggregateIds }, id: { notIn: beforeAuditIds } } });
    await prisma.serviceVerification.deleteMany({ where: { serviceId: { in: addedLegacyReviews.splice(0) } } });
    await prisma.service.deleteMany({ where: { id: { in: [...marketIds, ...LEGACY_CREDIT_SERVICE_IDS.filter((id) => !beforeServices.some((service) => service.id === id))] } } });
    for (const { id, ...data } of beforeServices) await prisma.service.update({ where: { id }, data });
    for (const { id, ...data } of beforeSellers) await prisma.seller.update({ where: { id }, data });
  });
  afterAll(async () => prisma.$disconnect());

  it("registers four independent unreviewed categories once, archives old IDs and preserves all historical evidence", async () => {
    await registerDemoServiceOptions(prisma);
    const a = await prisma.service.findUniqueOrThrow({ where: { id: "credit-report-a" }, include: { seller: true } });
    if (!(await prisma.serviceVerification.findUnique({ where: { serviceId: a.id } }))) {
      await prisma.serviceVerification.create({ data: {
        serviceId: a.id, status: "VERIFIED", bindingHash: serviceBindingHash(normalizeRegistryService(a)),
        scopes: ["endpoint_control", "wallet_control"], evidenceRef: "test:legacy-reviewed",
        reviewedBy: "catalog-test", reviewedAt: new Date(), expiresAt: new Date(Date.now() + 86400000),
      } });
      addedLegacyReviews.push(a.id);
    }
    const history = await completedPurchase();
    const draft = await prisma.task.create({ data: { prompt: "Keep this untouched draft" } });
    const survey = await prisma.task.create({ data: { prompt: "Keep this old survey", status: "WAITING_SELECTION", candidates: [{ serviceId: a.id }] } });
    taskIds.push(draft.id, survey.id);
    const oldServices = await prisma.service.findMany({ where: { id: { in: [...LEGACY_CREDIT_SERVICE_IDS] } }, include: { verification: true }, orderBy: { id: "asc" } });
    const oldBindings = await prisma.service.findMany({ where: { id: { in: [...LEGACY_CREDIT_SERVICE_IDS] } }, include: { seller: true }, orderBy: { id: "asc" } });
    const oldBindingHashes = oldBindings.map((service) => serviceBindingHash(normalizeRegistryService(service)));
    const oldHistory = await prisma.purchase.findUnique({ where: { id: history.id }, include: { payment: true, delivery: true, invoice: true, authorization: true, anchors: true, reconciliation: true } });
    const policies = await prisma.policy.findMany();
    const companies = await prisma.companyProfile.findMany();

    const results = await Promise.all([registerMarketServiceCatalog(prisma), registerMarketServiceCatalog(prisma)]);
    expect(results.flatMap((result) => result.created).sort()).toEqual([...marketIds].sort());
    expect(results.flatMap((result) => result.archived).sort()).toEqual([...LEGACY_CREDIT_SERVICE_IDS]);
    const services = await prisma.service.findMany({ where: { id: { in: marketIds } }, include: { seller: true, verification: true } });
    for (const expected of MARKET_SERVICE_CATALOG) {
      const actual = services.find((service) => service.id === expected.id)!;
      const source = oldServices.find((service) => service.id === expected.sourceId)!;
      expect(actual).toMatchObject({ id: expected.id, displayName: expected.displayName, sellerId: expected.sellerId,
        category: expected.category, priceAtomic: expected.priceAtomic, endpoint: source.endpoint,
        supportsTwInvoice: expected.supportsTwInvoice, active: true, verification: null,
        seller: { displayName: expected.sellerDisplayName, legalName: beforeSellers.find((seller) => seller.id === expected.sellerId)!.legalName } });
    }
    const archived = await prisma.service.findMany({ where: { id: { in: [...LEGACY_CREDIT_SERVICE_IDS] } }, include: { verification: true }, orderBy: { id: "asc" } });
    expect(archived.map((service, index) => ({ ...service, updatedAt: oldServices[index]!.updatedAt }))).toEqual(
      oldServices.map((service) => ({ ...service, active: false })),
    );
    const archivedBindings = await prisma.service.findMany({ where: { id: { in: [...LEGACY_CREDIT_SERVICE_IDS] } }, include: { seller: true }, orderBy: { id: "asc" } });
    expect(archivedBindings.map((service) => serviceBindingHash(normalizeRegistryService(service)))).toEqual(oldBindingHashes);
    expect(await prisma.purchase.findUnique({ where: { id: history.id }, include: { payment: true, delivery: true, invoice: true, authorization: true, anchors: true, reconciliation: true } })).toEqual(oldHistory);
    expect(await prisma.task.findUnique({ where: { id: draft.id } })).toEqual(draft);
    expect(await prisma.task.findUnique({ where: { id: survey.id } })).toEqual(survey);
    expect(await prisma.policy.findMany()).toEqual(policies);
    expect(await prisma.companyProfile.findMany()).toEqual(companies);
    expect(await prisma.auditEvent.count({ where: { eventType: "SERVICE_CATALOG_UPDATED", aggregateId: "mello-market-service-catalog-v1" } })).toBe(1);
    expect(await registerDemoServiceOptions(prisma)).toEqual({ created: [] });

    const advertised = services.map((service) => {
      const resource = resourceFixture(normalizeRegistryService(service));
      resource.extensions.bazaar.schema = { properties: { input: { properties: { body: { oneOf: [{
        type: "object", properties: { serviceId: { type: "string", const: service.id },
          serviceCategory: { type: "string", const: service.category }, serviceQuery: { type: "string", minLength: 1, maxLength: 200 } },
        required: ["serviceId", "serviceCategory", "serviceQuery"], additionalProperties: false,
      }] } } } } };
      return resource;
    });
    const registry = new ServiceRegistry(prisma, { search: vi.fn().mockResolvedValue(resultFixture(advertised)) });
    const discovery = await registry.discover(true);
    for (const id of marketIds) expect(discovery.assessments.find((assessment) => assessment.serviceId === id)).toMatchObject({ verification: { status: "UNREVIEWED" }, reasonCodes: ["VERIFICATION_UNREVIEWED"] });
  });

  it("does not recreate optional legacy C/D and preserves later reviews, prices and deactivation on startup", async () => {
    await registerMarketServiceCatalog(prisma);
    await prisma.service.update({ where: { id: "stock-analysis" }, data: { active: false, priceAtomic: "41000" } });
    await prisma.serviceVerification.create({ data: {
      serviceId: "stock-analysis", status: "REVOKED", bindingHash: hash, scopes: [],
      evidenceRef: "test:later-review", reviewedBy: "test-admin", reviewedAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000), revokedAt: new Date(),
    } });
    const before = await prisma.service.findMany({ where: { id: { in: marketIds } }, include: { verification: true }, orderBy: { id: "asc" } });
    const events = await prisma.auditEvent.count();
    expect(await registerMarketServiceCatalog(prisma)).toEqual({ created: [], archived: [], branded: [] });
    expect(await registerDemoServiceOptions(prisma)).toEqual({ created: [] });
    expect(await prisma.service.findMany({ where: { id: { in: marketIds } }, include: { verification: true }, orderBy: { id: "asc" } })).toEqual(before);
    expect(await prisma.auditEvent.count()).toBe(events);
    for (const id of ["credit-report-c", "credit-report-d"]) {
      if (!beforeServices.some((service) => service.id === id)) expect(await prisma.service.findUnique({ where: { id } })).toBeNull();
    }
  });

  it("fails closed on a pre-existing new ID, even if its category and provider look canonical", async () => {
    const source = await prisma.service.findUniqueOrThrow({ where: { id: "credit-report-a" } });
    await prisma.service.create({ data: { ...source, id: "stock-analysis", category: "stock_analysis", displayName: "個股分析" } });
    await expect(registerMarketServiceCatalog(prisma)).rejects.toThrow("without this catalog's registration evidence");
    expect(await prisma.service.findMany({ where: { id: { in: [...LEGACY_CREDIT_SERVICE_IDS] } } })).toEqual(beforeServices);
    expect(await prisma.seller.findMany({ where: { id: { in: ["seller-a", "seller-b"] } } })).toEqual(beforeSellers);
    expect(await prisma.service.count({ where: { id: { in: marketIds } } })).toBe(1);
  });

  it.each([
    { displayName: "Custom credit product" }, { priceAtomic: "12345" }, { active: false }, { sellerId: "seller-b" },
  ])("preserves unexpected customized source values without a partial migration: %j", async (data) => {
    await prisma.service.update({ where: { id: "credit-report-a" }, data });
    const customized = await prisma.service.findUnique({ where: { id: "credit-report-a" } });
    await expect(registerMarketServiceCatalog(prisma)).rejects.toThrow();
    expect(await prisma.service.findUnique({ where: { id: "credit-report-a" } })).toEqual(customized);
    expect(await prisma.service.count({ where: { id: { in: marketIds } } })).toBe(0);
    expect(await prisma.seller.findMany({ where: { id: { in: ["seller-a", "seller-b"] } } })).toEqual(beforeSellers);
  });

  it("refuses active jobs without archiving or branding anything", async () => {
    const task = await prisma.task.create({ data: { prompt: "Queued work" } });
    taskIds.push(task.id);
    const job = await prisma.workflowJob.create({ data: { kind: "RUN_TASK", aggregateId: task.id, payload: { taskId: task.id } } });
    jobIds.push(job.id);
    await expect(registerMarketServiceCatalog(prisma)).rejects.toThrow("Existing jobs, purchases and settlements");
    expect(await prisma.service.count({ where: { id: { in: marketIds } } })).toBe(0);
    expect(await prisma.service.findMany({ where: { id: { in: [...LEGACY_CREDIT_SERVICE_IDS] } } })).toEqual(beforeServices);
  });

  it.each(["SETTLEMENT_PENDING", "SIGNED_AUTHORIZATION", "ACTIVE_PURCHASE"] as const)("refuses %s evidence even if the task is terminal", async (kind) => {
    const purchase = await completedPurchase();
    if (kind === "SETTLEMENT_PENDING") await prisma.payment.update({ where: { purchaseId: purchase.id }, data: { status: "SETTLEMENT_PENDING" } });
    if (kind === "ACTIVE_PURCHASE") await prisma.purchase.update({ where: { id: purchase.id }, data: { status: "AUTHORIZED" } });
    if (kind === "SIGNED_AUTHORIZATION") await prisma.paymentAuthorization.create({ data: {
      purchaseId: purchase.id, paymentId: purchase.paymentId, status: "SIGNED", network: MELLO_NETWORK,
      tokenAddress: BASE_SEPOLIA_USDC, fromAddress: purchase.buyerAddress, toAddress: purchase.payToAddress,
      amountAtomic: purchase.expectedAmountAtomic, nonce: hash, validAfter: 0n,
      validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600), eip712Name: "USDC", eip712Version: "2",
      eip712ChainId: 84532n, typedDataHash: hash,
    } });
    await expect(registerMarketServiceCatalog(prisma)).rejects.toThrow("Existing jobs, purchases and settlements");
    expect(await prisma.service.count({ where: { id: { in: marketIds } } })).toBe(0);
  });

  it("refuses already-approved old selections while leaving their task evidence intact", async () => {
    const task = await prisma.task.create({ data: { prompt: "Previously approved", status: "WAITING_SELECTION", control: {
      create: { requestKey: `catalog-test-${randomUUID()}`, requestHash: hash,
        approvedTermsHash: hash, approvedAt: new Date(), requirements: {} as Prisma.InputJsonValue },
    } } });
    taskIds.push(task.id);
    const before = await prisma.task.findUnique({ where: { id: task.id }, include: { control: true } });
    await expect(registerMarketServiceCatalog(prisma)).rejects.toThrow("Only unapproved drafts");
    expect(await prisma.task.findUnique({ where: { id: task.id }, include: { control: true } })).toEqual(before);
    expect(await prisma.service.count({ where: { id: { in: marketIds } } })).toBe(0);
  });
});
