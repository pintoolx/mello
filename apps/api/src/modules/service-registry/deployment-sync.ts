import assert from "node:assert/strict";
import type { PrismaClient } from "@mello/db";
import { appendAuditEvent } from "../audit/index.js";
import { isPublicServiceEndpoint } from "./verification.js";

const IDS = ["credit-report-a", "credit-report-b"] as const;

export function publicBindingTargets(env: NodeJS.ProcessEnv) {
  return IDS.map((id, index) => {
    const key = index === 0 ? "SELLER_A_URL" : "SELLER_B_URL";
    const endpoint = `${env[key]?.replace(/\/$/, "")}/v1/credit-report`;
    assert.ok(isPublicServiceEndpoint(endpoint), `${key} must be an approved public HTTPS origin`);
    assert.equal(new URL(endpoint).pathname, "/v1/credit-report", "Only the existing report route can be migrated");
    return { id, endpoint, previousEndpoint: `http://seller-${index === 0 ? "a" : "b"}.railway.internal:8080/v1/credit-report` };
  });
}

export async function syncPublicSellerBindings(prisma: PrismaClient, env: NodeJS.ProcessEnv) {
  if (env["MELLO_SYNC_PUBLIC_SELLER_BINDINGS"] !== "true") return { skipped: true, updated: [] };
  const targets = publicBindingTargets(env);
  return prisma.$transaction(async (tx) => {
    // Same ordering as payment release: service verification, then payment gate.
    for (const { id } of targets) {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`mello:verification:${id}`}, 0)) IS NULL AS acquired`;
    }
    await tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${"mello:payment-release-gate"}, 0)) IS NULL AS acquired`;
    assert.equal((await tx.paymentControl.findUnique({ where: { id: "global" } }))?.paymentsFrozen, true,
      "Freeze new payments before migrating public seller bindings");
    const activeJobs = await tx.workflowJob.count({ where: { status: { in: ["PENDING", "RUNNING", "FAILED_RETRYABLE"] } } });
    const activeTasks = await tx.task.count({ where: { status: { notIn: ["COMPLETED", "REJECTED", "FAILED"] } } });
    const uncertainPayments = await tx.payment.count({ where: { status: { in: ["AUTHORIZED", "SETTLEMENT_PENDING"] } } });
    assert.equal(activeJobs + activeTasks + uncertainPayments, 0, "Existing work must finish before migrating service bindings");
    const updated: { serviceId: string; endpoint: string }[] = [];
    for (const target of targets) {
      const service = await tx.service.findUniqueOrThrow({ where: { id: target.id } });
      assert.equal(service.method, "POST");
      assert.ok(service.endpoint === target.previousEndpoint || service.endpoint === target.endpoint,
        "An unexpected existing endpoint requires a separate reviewed update");
      if (service.endpoint === target.endpoint) continue;
      await tx.service.update({ where: { id: target.id }, data: { endpoint: target.endpoint } });
      await appendAuditEvent(tx, {
        aggregateType: "SERVICE", aggregateId: target.id, actorType: "ADMIN",
        eventType: "SERVICE_BINDING_UPDATED", payload: {
          operation: "APPROVED_PUBLIC_SELLER_DEPLOYMENT", previousEndpoint: service.endpoint,
          endpoint: target.endpoint, priceAtomic: service.priceAtomic,
          automaticCertification: false, historicalPurchasesChanged: false,
        },
      });
      updated.push({ serviceId: target.id, endpoint: target.endpoint });
    }
    return { skipped: false, updated };
  });
}
