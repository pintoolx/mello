import assert from "node:assert/strict";
import type { PrismaClient } from "@mello/db";
import { appendAuditEvent } from "../audit/index.js";
import { marketCatalogIsRegistered } from "./market-service-catalog.js";

const OPTIONS = [
  { id: "credit-report-c", sourceId: "credit-report-b", sellerId: "seller-b", displayName: "Mello 信用報告 C（Demo）", supportsTwInvoice: true },
  { id: "credit-report-d", sourceId: "credit-report-a", sellerId: "seller-a", displayName: "Mello 信用報告 D（Demo）", supportsTwInvoice: false },
] as const;

/** Independent demo catalog entries fulfilled by the existing demo providers. */
export async function registerDemoServiceOptions(prisma: PrismaClient) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"mello:demo-service-options"}, 0)) IS NULL AS acquired`;
    // The old helper remains available for legacy fixtures, but must never
    // recreate or reactivate credit reports after the market catalog transition.
    if (await marketCatalogIsRegistered(tx)) return { created: [] };
    const created: string[] = [];
    for (const option of OPTIONS) {
      const existing = await tx.service.findUnique({ where: { id: option.id } });
      if (existing) {
        assert.equal(existing.sellerId, option.sellerId, "Demo service ID belongs to another provider");
        // Re-deploying preserves later edits, deactivations and review decisions.
        continue;
      }
      const source = await tx.service.findUniqueOrThrow({ where: { id: option.sourceId }, include: { seller: true } });
      assert.equal(source.sellerId, option.sellerId, "Unexpected source provider");
      assert.ok(source.active && source.seller.status === "ACTIVE", "Source service must be active");
      assert.equal(source.category, "credit_report", "Unexpected source category");
      assert.equal(source.supportsTwInvoice, option.supportsTwInvoice, "Unexpected source invoice capability");
      assert.equal(source.seller.invoiceCapability, option.supportsTwInvoice ? "TW_B2B_DEMO" : "NONE");
      await tx.service.create({ data: {
        id: option.id, displayName: option.displayName, sellerId: source.sellerId,
        category: source.category, endpoint: source.endpoint, method: source.method,
        priceAtomic: source.priceAtomic, tokenSymbol: source.tokenSymbol,
        tokenAddress: source.tokenAddress, tokenDecimals: source.tokenDecimals,
        network: source.network, supportsTwInvoice: source.supportsTwInvoice, active: true,
      } });
      // Certification belongs to a service ID; source reviews are never copied.
      await appendAuditEvent(tx, {
        aggregateType: "SERVICE", aggregateId: option.id, sellerId: source.sellerId,
        eventType: "SERVICE_REGISTERED", payload: {
          operation: "ADD_DEMO_SERVICE_OPTION", sourceServiceId: source.id,
          displayName: option.displayName, endpoint: source.endpoint,
          priceAtomic: source.priceAtomic, supportsTwInvoice: source.supportsTwInvoice,
          sharedDemoFulfillment: true, certificationIssued: false,
        },
      });
      created.push(option.id);
    }
    return { created };
  });
}
