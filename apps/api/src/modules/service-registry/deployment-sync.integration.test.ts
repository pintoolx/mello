import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { PrismaClient } from "@mello/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafeIntegrationDatabase } from "../../../scripts/integration-database-safety.js";
import { seedDemo } from "../../db/seed.js";
import { syncPublicSellerBindings } from "./deployment-sync.js";

describe.sequential("opt-in atomic public deployment binding sync", () => {
  const env = { MELLO_SYNC_PUBLIC_SELLER_BINDINGS: "true", SELLER_A_URL: "https://seller-a.example.com", SELLER_B_URL: "https://seller-b.example.com" };
  const schema = `public_sync_test_${randomUUID().replaceAll("-", "")}`;
  let prisma: PrismaClient | undefined;
  const auditStart = 0n;
  beforeAll(async () => {
    assertSafeIntegrationDatabase({ databaseUrl: process.env["DATABASE_URL"], databaseApproved: process.env["MELLO_INTEGRATION_DATABASE_APPROVED"] });
    const databaseUrl = new URL(process.env["DATABASE_URL"]!);
    databaseUrl.searchParams.set("schema", schema);
    // The deployment guard must see the entire database namespace as idle.
    // Use a fresh, test-owned schema instead of changing other suites' tasks.
    prisma = new PrismaClient({ datasourceUrl: databaseUrl.href });
    try {
      await promisify(execFile)(process.execPath, [createRequire(import.meta.url).resolve("prisma/build/index.js"), "migrate", "deploy", "--schema", "prisma/schema.prisma"], {
        cwd: new URL("../../../", import.meta.url),
        env: { ...process.env, DATABASE_URL: databaseUrl.href, DIRECT_DATABASE_URL: databaseUrl.href },
        timeout: 25_000,
      });
    } catch { throw new Error("Could not migrate the isolated local deployment-sync test schema"); }
    await seedDemo(prisma);
  });
  afterAll(async () => {
    if (!prisma) return;
    try {
      // Only this generated schema is disposable; never reset the shared DB.
      if (!/^public_sync_test_[a-f0-9]{32}$/.test(schema)) throw new Error("Unexpected test schema");
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally { await prisma.$disconnect(); }
  });
  it("does nothing without the explicit deployment opt-in", async () => {
    expect(await syncPublicSellerBindings(prisma!, {})).toEqual({ skipped: true, updated: [] });
  });
  it("refuses unfrozen payments and invalid public targets", async () => {
    await prisma!.paymentControl.upsert({ where: { id: "global" }, create: { id: "global", paymentsFrozen: false }, update: { paymentsFrozen: false } });
    await expect(syncPublicSellerBindings(prisma!, env)).rejects.toThrow("Freeze new payments");
    await expect(syncPublicSellerBindings(prisma!, { ...env, SELLER_A_URL: "http://localhost:8080" })).rejects.toThrow("public HTTPS");
  });
  it("refuses pending jobs even when all payment controls are frozen", async () => {
    await prisma!.paymentControl.update({ where: { id: "global" }, data: { paymentsFrozen: true } });
    const job = await prisma!.workflowJob.create({ data: { kind: "RUN_TASK", aggregateId: randomUUID(), payload: {}, status: "PENDING" } });
    try { await expect(syncPublicSellerBindings(prisma!, env)).rejects.toThrow("Existing work must finish"); }
    finally { await prisma!.workflowJob.delete({ where: { id: job.id } }); }
  });
  it("rolls back the first endpoint and audit if the second endpoint is unexpected", async () => {
    await prisma!.service.update({ where: { id: "credit-report-a" }, data: { endpoint: "http://seller-a.railway.internal:8080/v1/credit-report" } });
    await prisma!.service.update({ where: { id: "credit-report-b" }, data: { endpoint: "https://custom-seller.example.com/v1/credit-report" } });
    await expect(syncPublicSellerBindings(prisma!, env)).rejects.toThrow("unexpected existing endpoint");
    expect((await prisma!.service.findUniqueOrThrow({ where: { id: "credit-report-a" } })).endpoint).toBe("http://seller-a.railway.internal:8080/v1/credit-report");
    expect(await prisma!.auditEvent.count({ where: { sequence: { gt: auditStart }, aggregateType: "SERVICE" } })).toBe(0);
  });
  it("migrates both known routes once without modifying price, policy, purchases or reviews", async () => {
    await prisma!.service.update({ where: { id: "credit-report-b" }, data: { endpoint: "http://seller-b.railway.internal:8080/v1/credit-report" } });
    const before = { purchases: await prisma!.purchase.count(), reviews: await prisma!.serviceVerification.count(), policy: await prisma!.policy.findMany() };
    expect((await syncPublicSellerBindings(prisma!, env)).updated).toHaveLength(2);
    expect((await syncPublicSellerBindings(prisma!, env)).updated).toHaveLength(0);
    expect({ purchases: await prisma!.purchase.count(), reviews: await prisma!.serviceVerification.count(), policy: await prisma!.policy.findMany() }).toEqual(before);
    expect((await prisma!.service.findUniqueOrThrow({ where: { id: "credit-report-b" } })).priceAtomic).toBe("50000");
  });
});
