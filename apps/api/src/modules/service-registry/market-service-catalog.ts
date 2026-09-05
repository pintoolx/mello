import assert from "node:assert/strict";
import type { Prisma, PrismaClient } from "@mello/db";
import { BASE_SEPOLIA_USDC, MARKET_SERVICE_CATALOG, MELLO_NETWORK, USDC_DECIMALS } from "@mello/shared";
import { appendAuditEvent } from "../audit/index.js";
import { acquireWorkflowQueueExclusiveLock } from "../workflow-jobs/queue-lock.js";

const OPERATION = "REGISTER_MARKET_SERVICES_V1";
const CATALOG_ID = "mello-market-service-catalog-v1";
export const LEGACY_CREDIT_SERVICE_IDS = ["credit-report-a", "credit-report-b", "credit-report-c", "credit-report-d"] as const;
const MARKET_IDS = MARKET_SERVICE_CATALOG.map((service) => service.id);
const LEGACY_TARGETS = [
  { id: "credit-report-a", sellerId: "seller-a", displayName: null, priceAtomic: "40000", supportsTwInvoice: false },
  { id: "credit-report-b", sellerId: "seller-b", displayName: null, priceAtomic: "50000", supportsTwInvoice: true },
  { id: "credit-report-c", sellerId: "seller-b", displayName: "Mello 信用報告 C（Demo）", priceAtomic: "50000", supportsTwInvoice: true },
  { id: "credit-report-d", sellerId: "seller-a", displayName: "Mello 信用報告 D（Demo）", priceAtomic: "40000", supportsTwInvoice: false },
] as const;

/** A committed marker distinguishes our catalog from pre-existing/custom IDs. */
export async function marketCatalogIsRegistered(tx: Prisma.TransactionClient): Promise<boolean> {
  const marker = await tx.auditEvent.findFirst({ where: {
    aggregateType: "SERVICE", aggregateId: CATALOG_ID, eventType: "SERVICE_CATALOG_UPDATED",
    payload: { path: ["operation"], equals: OPERATION },
  }, select: { id: true } });
  const services = await tx.service.findMany({ where: { id: { in: MARKET_IDS } }, select: { id: true, sellerId: true, category: true } });
  if (!marker) {
    assert.equal(services.length, 0, "A market service ID already exists without this catalog's registration evidence");
    return false;
  }
  assert.equal(services.length, MARKET_SERVICE_CATALOG.length, "Registered market catalog is incomplete; explicit repair is required");
  for (const expected of MARKET_SERVICE_CATALOG) {
    const actual = services.find((service) => service.id === expected.id);
    assert.ok(actual && actual.sellerId === expected.sellerId && actual.category === expected.category,
      "Registered market service identity changed; explicit review is required");
  }
  // Subsequent administrative changes, deactivations and reviews are retained.
  return true;
}

async function assertNoInFlightWork(tx: Prisma.TransactionClient): Promise<void> {
  const activeJobs = await tx.workflowJob.count({ where: { status: { in: ["PENDING", "RUNNING", "FAILED_RETRYABLE"] } } });
  const activePurchases = await tx.purchase.count({ where: { status: { notIn: ["COMPLETED", "FAILED"] } } });
  const uncertainPayments = await tx.payment.count({ where: { status: { in: ["AUTHORIZED", "SETTLEMENT_PENDING"] } } });
  const signedAuthorizations = await tx.paymentAuthorization.count({ where: {
    status: { in: ["SIGNED", "SUBMITTED"] }, validBefore: { gt: BigInt(Math.floor(Date.now() / 1000)) },
  } });
  const sellerSettlements = await tx.sellerPaymentCache.count({ where: {
    sellerId: { in: ["seller-a", "seller-b"] }, status: { in: ["PROCESSING", "SETTLING"] },
  } });
  assert.equal(activeJobs + activePurchases + uncertainPayments + signedAuthorizations + sellerSettlements, 0,
    "Existing jobs, purchases and settlements must finish before archiving legacy services");
  const tasks = await tx.task.findMany({
    where: { status: { notIn: ["COMPLETED", "REJECTED", "FAILED"] } }, take: 1001,
    select: { status: true, purchase: { select: { id: true } }, control: { select: {
      pendingTerms: true, approvedTermsHash: true, approvedAt: true, paymentReleaseGrantedAt: true,
    } } },
  });
  assert.ok(tasks.length <= 1000, "Too many unfinished tasks for a bounded catalog transition");
  for (const task of tasks) {
    assert.ok(["CREATED", "WAITING_SELECTION"].includes(task.status) && task.purchase === null &&
      (task.control === null || [task.control.pendingTerms, task.control.approvedTermsHash,
        task.control.approvedAt, task.control.paymentReleaseGrantedAt].every((value) => value === null)),
    "Only unapproved drafts and unselected surveys may remain during catalog registration");
  }
}

/**
 * One bounded transition, not a seed reset or an ongoing configuration sync.
 * New IDs get no certification. Legacy financial evidence and legal identities
 * are never rewritten; old selections fail the existing inactive-service guard.
 */
export async function registerMarketServiceCatalog(prisma: PrismaClient) {
  return prisma.$transaction(async (tx) => {
    // Fence enqueue/claim, then follow service-review -> payment-release order.
    // The legacy registrar shares the second lock so it cannot recreate C/D.
    await acquireWorkflowQueueExclusiveLock(tx);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"mello:demo-service-options"}, 0)) IS NULL AS acquired`;
    if (await marketCatalogIsRegistered(tx)) return { created: [], archived: [], branded: [] };
    for (const id of [...LEGACY_CREDIT_SERVICE_IDS, ...MARKET_IDS].sort()) {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`mello:verification:${id}`}, 0)) IS NULL AS acquired`;
    }
    await tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${"mello:payment-release-gate"}, 0)) IS NULL AS acquired`;
    await assertNoInFlightWork(tx);

    const legacy = await tx.service.findMany({ where: { id: { in: [...LEGACY_CREDIT_SERVICE_IDS] } }, include: { seller: true } });
    for (const expected of LEGACY_TARGETS) {
      const service = legacy.find((item) => item.id === expected.id);
      // A/B are required deployment bindings; C/D were optional demo additions.
      if (!service && ["credit-report-c", "credit-report-d"].includes(expected.id)) continue;
      assert.ok(service, "Required legacy demo provider is missing");
      if (["credit-report-a", "credit-report-b"].includes(expected.id)) {
        assert.equal(service.active, true, "An inactive source must not silently receive replacement services");
      }
      assert.equal(service.sellerId, expected.sellerId, "Unexpected legacy provider");
      assert.equal(service.displayName, expected.displayName, "Custom legacy display names need an explicit migration review");
      assert.equal(service.category, "credit_report", "Unexpected legacy category");
      assert.equal(service.method, "POST", "Unexpected legacy HTTP method");
      assert.equal(service.priceAtomic, expected.priceAtomic, "Custom legacy pricing needs an explicit migration review");
      assert.equal(service.network, MELLO_NETWORK, "Market demo registration is limited to Base Sepolia");
      assert.equal(service.tokenSymbol, "USDC");
      assert.equal(service.tokenAddress.toLowerCase(), BASE_SEPOLIA_USDC.toLowerCase());
      assert.equal(service.tokenDecimals, USDC_DECIMALS);
      assert.equal(service.supportsTwInvoice, expected.supportsTwInvoice);
      const endpoint = new URL(service.endpoint);
      assert.ok(["http:", "https:"].includes(endpoint.protocol) && endpoint.pathname === "/v1/credit-report" &&
        !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, "Unexpected legacy fulfillment endpoint");
      if (["credit-report-c", "credit-report-d"].includes(expected.id)) {
        const sourceId = expected.sellerId === "seller-a" ? "credit-report-a" : "credit-report-b";
        assert.equal(service.endpoint, legacy.find((item) => item.id === sourceId)?.endpoint,
          "Custom optional-service endpoints need an explicit migration review");
      }
      const role = expected.sellerId === "seller-a" ? "A" : "B";
      assert.equal(service.seller.legalName, `Mello Data Labs ${role} (Demo)`, "Custom legal identities need a separate reviewed registration");
      assert.equal(service.seller.status, "ACTIVE", "Disabled sellers must not receive new active services");
      assert.equal(service.seller.invoiceCapability, expected.supportsTwInvoice ? "TW_B2B_DEMO" : "NONE");
      assert.equal(service.seller.invoiceProvider, expected.supportsTwInvoice ? "MOCK" : "NONE");
      const brand = expected.sellerId === "seller-a" ? "會飛分析師" : "mello資本";
      assert.ok(service.seller.displayName === null || service.seller.displayName === brand,
        "Custom seller branding needs an explicit migration review");
    }

    const created: string[] = [];
    const archived: string[] = [];
    const branded: string[] = [];
    for (const entry of MARKET_SERVICE_CATALOG) {
      const source = legacy.find((service) => service.id === entry.sourceId)!;
      if (!branded.includes(source.sellerId) && source.seller.displayName !== entry.sellerDisplayName) {
        await tx.seller.update({ where: { id: source.sellerId }, data: { displayName: entry.sellerDisplayName } });
        branded.push(source.sellerId);
      }
      await tx.service.create({ data: {
        id: entry.id, displayName: entry.displayName, sellerId: entry.sellerId, category: entry.category,
        endpoint: source.endpoint, method: source.method, priceAtomic: source.priceAtomic,
        tokenSymbol: source.tokenSymbol, tokenAddress: source.tokenAddress, tokenDecimals: source.tokenDecimals,
        network: source.network, supportsTwInvoice: source.supportsTwInvoice, active: true,
      } });
      await appendAuditEvent(tx, { aggregateType: "SERVICE", aggregateId: entry.id, sellerId: entry.sellerId,
        eventType: "SERVICE_REGISTERED", payload: {
          operation: OPERATION, sourceServiceId: source.id, category: entry.category,
          displayName: entry.displayName, sellerDisplayName: entry.sellerDisplayName,
          endpoint: source.endpoint, priceAtomic: source.priceAtomic,
          sharedDemoFulfillment: true, certificationIssued: false, historicalPurchasesChanged: false,
        } });
      created.push(entry.id);
    }
    for (const service of legacy) {
      if (!service.active) continue;
      await tx.service.update({ where: { id: service.id }, data: { active: false } });
      await appendAuditEvent(tx, { aggregateType: "SERVICE", aggregateId: service.id, sellerId: service.sellerId,
        eventType: "SERVICE_ARCHIVED", payload: {
          operation: OPERATION, previousActive: true, active: false,
          metadataPreserved: true, certificationPreserved: true, historicalPurchasesChanged: false,
        } });
      archived.push(service.id);
    }
    await appendAuditEvent(tx, { aggregateType: "SERVICE", aggregateId: CATALOG_ID,
      eventType: "SERVICE_CATALOG_UPDATED", payload: {
        operation: OPERATION, created, archived, branded,
        certificationIssued: false, historicalPurchasesChanged: false,
      } });
    return { created, archived, branded };
  }, { maxWait: 5000, timeout: 15000 });
}
