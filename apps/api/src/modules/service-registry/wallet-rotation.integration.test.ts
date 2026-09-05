import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { PrismaClient, type Prisma } from "@mello/db";
import { BASE_SEPOLIA_USDC, DEMO_COMPANY_ID, MELLO_NETWORK } from "@mello/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafeIntegrationDatabase } from "../../../scripts/integration-database-safety.js";
import { loadConfig } from "../../config.js";
import { seedDemo } from "../../db/seed.js";
import { PrismaCoreApiRepository } from "../../http/prisma-core-api-repository.js";
import { ProcurementControls } from "../controls/procurement-controls.js";
import { normalizeRegistryService } from "./registry-service.js";
import { serviceBindingHash, verificationSummary } from "./verification.js";
import { rotateSellerWallets, sellerWalletRotationTargets } from "./wallet-rotation.js";

describe.sequential("opt-in atomic seller wallet rotation", () => {
  const env = {
    MELLO_ROTATE_SELLER_WALLETS: "true",
    SELLER_A_URL: "https://seller-a.example.com", SELLER_B_URL: "https://seller-b.example.com",
    SELLER_A_PREVIOUS_PAY_TO: "0x1111111111111111111111111111111111111111",
    SELLER_B_PREVIOUS_PAY_TO: "0x2222222222222222222222222222222222222222",
    SELLER_A_PAY_TO: "0x3333333333333333333333333333333333333333",
    SELLER_B_PAY_TO: "0x4444444444444444444444444444444444444444",
  };
  const schema = `wallet_rotation_test_${randomUUID().replaceAll("-", "")}`;
  const taskId = randomUUID();
  const purchaseId = randomUUID();
  const paymentId = `rotation-history-${randomUUID()}`;
  const hash = `0x${"1".repeat(64)}`;
  const draftIds: string[] = [];
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    assertSafeIntegrationDatabase({ databaseUrl: process.env["DATABASE_URL"], databaseApproved: process.env["MELLO_INTEGRATION_DATABASE_APPROVED"] });
    const databaseUrl = new URL(process.env["DATABASE_URL"]!);
    databaseUrl.searchParams.set("schema", schema);
    prisma = new PrismaClient({ datasourceUrl: databaseUrl.href });
    try {
      await promisify(execFile)(process.execPath, [createRequire(import.meta.url).resolve("prisma/build/index.js"), "migrate", "deploy", "--schema", "prisma/schema.prisma"], {
        cwd: new URL("../../../", import.meta.url),
        env: { ...process.env, DATABASE_URL: databaseUrl.href, DIRECT_DATABASE_URL: databaseUrl.href }, timeout: 25_000,
      });
    } catch { throw new Error("Could not migrate the isolated local wallet-rotation test schema"); }
    await seedDemo(prisma);
    for (const target of sellerWalletRotationTargets(env)) {
      await prisma.service.update({ where: { id: target.id }, data: { endpoint: target.endpoint } });
      await prisma.seller.update({ where: { id: target.sellerId }, data: { payToAddress: target.previousPayTo } });
    }
    const draft = await prisma.task.create({ data: { prompt: "unused draft without control" } });
    const consoleDraft = await new ProcurementControls(prisma).createTask({
      prompt: "unused UI draft with initial approval limit", requestKey: randomUUID(), approvalLimitAtomic: "40000",
    });
    draftIds.push(draft.id, consoleDraft.id);
    await prisma.paymentControl.upsert({ where: { id: "global" }, create: { id: "global", paymentsFrozen: true }, update: { paymentsFrozen: true } });
    await prisma.task.create({ data: { id: taskId, prompt: "historical completed purchase", status: "COMPLETED" } });
    await prisma.purchase.create({ data: {
      id: purchaseId, taskId, buyerProfileId: DEMO_COMPANY_ID, serviceId: "credit-report-b", paymentId,
      expectedAmountAtomic: "50000", actualAmountAtomic: "50000", network: MELLO_NETWORK,
      tokenSymbol: "USDC", tokenAddress: BASE_SEPOLIA_USDC, tokenDecimals: 6,
      buyerAddress: "0x9999999999999999999999999999999999999999", payToAddress: env.SELLER_B_PREVIOUS_PAY_TO,
      policySnapshot: { original: true }, mandateHash: hash, policyHash: hash,
      expiresAt: new Date("2030-01-01"), status: "COMPLETED",
      payment: { create: { paymentId, status: "SETTLED", payeeAddress: env.SELLER_B_PREVIOUS_PAY_TO,
        amountAtomic: "50000", transactionHash: hash, paymentRequired: { accepts: [{ payTo: env.SELLER_B_PREVIOUS_PAY_TO }] } } },
      invoice: { create: { status: "ISSUED_DEMO", provider: "MOCK", invoiceNumber: "DEMO-HISTORICAL", attemptCount: 2, canonicalHash: hash } },
      delivery: { create: { status: "DELIVERED", responseHash: hash, responseBody: { report: "historical" } } },
      reconciliation: { create: { status: "MATCHED", checks: { payTo: env.SELLER_B_PREVIOUS_PAY_TO }, canonicalHash: hash } },
      anchors: { create: [{ kind: "AUTHORIZE", status: "CONFIRMED", transactionHash: hash },
        { kind: "FINALIZE", status: "CONFIRMED", transactionHash: hash }] },
    } });
    const record = await prisma.service.findUniqueOrThrow({ where: { id: "credit-report-b" }, include: { seller: true } });
    await prisma.serviceVerification.create({ data: {
      serviceId: record.id, status: "VERIFIED", bindingHash: serviceBindingHash(normalizeRegistryService(record)),
      scopes: ["ENDPOINT_CONTROL", "PAYMENT_WALLET_CONTROL", "DEMO_INVOICE_INTEGRATION"],
      evidenceRef: "local-test:old-wallet-review", reviewedBy: "integration-test",
      reviewedAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86_400_000),
    } });
    await prisma.auditEvent.create({ data: { aggregateType: "PURCHASE", aggregateId: purchaseId, purchaseId,
      actorType: "SYSTEM", eventType: "INVOICE_ISSUED", payload: { status: "ISSUED_DEMO", attempt: 2, previousStatus: "FAILED_RETRYABLE" } } });
  });
  afterAll(async () => {
    if (!prisma) return;
    try {
      if (!/^wallet_rotation_test_[a-f0-9]{32}$/.test(schema)) throw new Error("Unexpected test schema");
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally { await prisma.$disconnect(); }
  });

  async function retainedHistory() {
    const repository = new PrismaCoreApiRepository(prisma!, loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgresql://localhost/mello_test" }));
    return {
      drafts: await prisma!.task.findMany({ where: { id: { in: draftIds } }, include: { control: true, purchase: true }, orderBy: { id: "asc" } }),
      draftReadModels: JSON.stringify(await Promise.all(draftIds.map(async (id) => ({
        detail: await repository.getTaskDetail(id), control: await new ProcurementControls(prisma!).detail(id),
      })))),
      purchases: await prisma!.purchase.findMany({ include: {
        task: { include: { control: true } }, payment: true, authorization: true, authorizationNonces: true,
        invoice: true, delivery: true, reconciliation: true, anchors: { orderBy: { kind: "asc" } },
      } }),
      reviews: await prisma!.serviceVerification.findMany(),
      services: await prisma!.service.findMany({ orderBy: { id: "asc" } }),
      policy: await prisma!.policy.findMany(), company: await prisma!.companyProfile.findMany(),
      audit: await prisma!.auditEvent.findMany({ where: { aggregateType: { not: "SERVICE" } }, orderBy: { sequence: "asc" } }),
    };
  }

  it("refuses unfrozen controls", async () => {
    await prisma!.paymentControl.update({ where: { id: "global" }, data: { paymentsFrozen: false } });
    try { await expect(rotateSellerWallets(prisma!, env)).rejects.toThrow("Freeze new payments"); }
    finally { await prisma!.paymentControl.update({ where: { id: "global" }, data: { paymentsFrozen: true } }); }
  });
  it.each(["PENDING", "RUNNING", "FAILED_RETRYABLE"] as const)("refuses %s jobs even with pristine drafts", async (status) => {
    const job = await prisma!.workflowJob.create({ data: {
      kind: "RUN_TASK", aggregateId: draftIds[0]!, payload: {}, status,
      ...(status === "RUNNING" ? { lockedAt: new Date(), lockedBy: "wallet-rotation-test", attempts: 1 } : {}),
    } });
    try { await expect(rotateSellerWallets(prisma!, env)).rejects.toThrow("Existing work"); }
    finally { await prisma!.workflowJob.delete({ where: { id: job.id } }); }
  });
  it.each<[string, Prisma.TaskCreateInput]>([
    ["started run", { prompt: "started draft", runStartedAt: new Date() }],
    ["previous completion", { prompt: "completed draft", completedAt: new Date() }],
    ["intent", { prompt: "parsed draft", intent: {} }],
    ["candidates", { prompt: "discovered draft", candidates: [] }],
    ["decision", { prompt: "decision draft", decisionSummary: "previous decision" }],
    ["error", { prompt: "error draft", errorCode: "PREVIOUS_FAILURE" }],
    ["fallback parser", { prompt: "fallback draft", usedFallbackParser: true }],
  ])("refuses a CREATED draft with %s evidence without rewriting drafts", async (_name, data) => {
    const before = await retainedHistory();
    const draft = await prisma!.task.create({ data });
    try {
      await expect(rotateSellerWallets(prisma!, env)).rejects.toThrow("Existing work");
      expect(await retainedHistory()).toEqual(before);
      expect(await prisma!.auditEvent.count({ where: { aggregateType: "SERVICE" } })).toBe(0);
    } finally { await prisma!.task.delete({ where: { id: draft.id } }); }
  });
  it.each<[string, Partial<Prisma.TaskControlCreateWithoutTaskInput>]>([
    ["pinned wallet", { expectedPayTo: env.SELLER_B_PREVIOUS_PAY_TO }],
    ["pending terms", { pendingTerms: { payTo: env.SELLER_B_PREVIOUS_PAY_TO } }],
    ["approved terms", { approvedTermsHash: hash }],
    ["approval", { approvedAt: new Date() }],
    ["release permit", { paymentReleaseGrantedAt: new Date() }],
  ])("refuses a CREATED draft with %s control evidence", async (_name, control) => {
    const before = await retainedHistory();
    const draft = await prisma!.task.create({ data: { prompt: "controlled prior purchase", control: { create: {
      requestKey: randomUUID(), requestHash: hash, ...control,
    } } } });
    try {
      await expect(rotateSellerWallets(prisma!, env)).rejects.toThrow("Existing work");
      expect(await retainedHistory()).toEqual(before);
      expect(await prisma!.auditEvent.count({ where: { aggregateType: "SERVICE" } })).toBe(0);
    } finally { await prisma!.task.delete({ where: { id: draft.id } }); }
  });
  it("refuses an active task, purchase, or uncertain settlement independently", async () => {
    await prisma!.task.update({ where: { id: taskId }, data: { status: "ACTION_REQUIRED" } });
    try { await expect(rotateSellerWallets(prisma!, env)).rejects.toThrow("Existing work"); }
    finally { await prisma!.task.update({ where: { id: taskId }, data: { status: "COMPLETED" } }); }
    await prisma!.task.update({ where: { id: taskId }, data: { status: "CREATED" } });
    try { await expect(rotateSellerWallets(prisma!, env)).rejects.toThrow("Existing work"); }
    finally { await prisma!.task.update({ where: { id: taskId }, data: { status: "COMPLETED" } }); }
    await prisma!.purchase.update({ where: { id: purchaseId }, data: { status: "ACTION_REQUIRED" } });
    try { await expect(rotateSellerWallets(prisma!, env)).rejects.toThrow("Existing work"); }
    finally { await prisma!.purchase.update({ where: { id: purchaseId }, data: { status: "COMPLETED" } }); }
    await prisma!.payment.update({ where: { purchaseId }, data: { status: "SETTLEMENT_PENDING" } });
    try { await expect(rotateSellerWallets(prisma!, env)).rejects.toThrow("Existing work"); }
    finally { await prisma!.payment.update({ where: { purchaseId }, data: { status: "SETTLED" } }); }
  });
  it("refuses known in-flight public seller payment attempts", async () => {
    const cache = await prisma!.sellerPaymentCache.create({ data: {
      sellerId: "seller-b", route: "/v1/credit-report", paymentId: randomUUID(), fingerprint: hash,
      status: "SETTLING", claimToken: randomUUID(), expiresAt: new Date(Date.now() + 60_000),
    } });
    try { await expect(rotateSellerWallets(prisma!, env)).rejects.toThrow("seller settlements"); }
    finally { await prisma!.sellerPaymentCache.delete({ where: { id: cache.id } }); }
  });
  it("refuses an unexpected second wallet without changing the first or creating audit events", async () => {
    await prisma!.seller.update({ where: { id: "seller-b" }, data: { payToAddress: "0x5555555555555555555555555555555555555555" } });
    try {
      await expect(rotateSellerWallets(prisma!, env)).rejects.toThrow("Unexpected existing seller wallet");
      expect((await prisma!.seller.findUniqueOrThrow({ where: { id: "seller-a" } })).payToAddress).toBe(env.SELLER_A_PREVIOUS_PAY_TO);
      expect(await prisma!.auditEvent.count({ where: { aggregateType: "SERVICE" } })).toBe(0);
    } finally { await prisma!.seller.update({ where: { id: "seller-b" }, data: { payToAddress: env.SELLER_B_PREVIOUS_PAY_TO } }); }
  });
  it.each<[string, Prisma.ServiceUpdateInput]>([
    ["endpoint", { endpoint: "https://unexpected.example.com/v1/credit-report" }],
    ["price", { priceAtomic: "50001" }], ["network", { network: "eip155:8453" }],
    ["asset", { tokenAddress: "0x5555555555555555555555555555555555555555" }],
    ["method", { method: "GET" }], ["invoice support", { supportsTwInvoice: false }],
  ])("refuses an unexpected %s without partial rotation", async (_name, change) => {
    const before = await prisma!.service.findUniqueOrThrow({ where: { id: "credit-report-b" } });
    await prisma!.service.update({ where: { id: before.id }, data: change });
    try {
      await expect(rotateSellerWallets(prisma!, env)).rejects.toThrow();
      expect((await prisma!.seller.findUniqueOrThrow({ where: { id: "seller-a" } })).payToAddress).toBe(env.SELLER_A_PREVIOUS_PAY_TO);
      expect(await prisma!.auditEvent.count({ where: { aggregateType: "SERVICE" } })).toBe(0);
    } finally { await prisma!.service.update({ where: { id: before.id }, data: before }); }
  });
  it("refuses a seller shared by an additional, unlocked service", async () => {
    const service = await prisma!.service.findUniqueOrThrow({ where: { id: "credit-report-b" } });
    const extraId = `additional-${randomUUID()}`;
    await prisma!.service.create({ data: { ...service, id: extraId } });
    try { await expect(rotateSellerWallets(prisma!, env)).rejects.toThrow("Additional services"); }
    finally { await prisma!.service.delete({ where: { id: extraId } }); }
  });
  it("rotates once, preserves untouched drafts/read models and all historical evidence, and invalidates old trust without altering its record", async () => {
    const before = await retainedHistory();
    const beforeRecord = await prisma!.service.findUniqueOrThrow({ where: { id: "credit-report-b" }, include: { seller: true, verification: true } });
    expect(verificationSummary(normalizeRegistryService(beforeRecord), beforeRecord.verification).status).toBe("VERIFIED");
    expect((await rotateSellerWallets(prisma!, env)).updated).toHaveLength(2);
    expect((await rotateSellerWallets(prisma!, env)).updated).toHaveLength(0);
    expect(await retainedHistory()).toEqual(before);
    const record = await prisma!.service.findUniqueOrThrow({ where: { id: "credit-report-b" }, include: { seller: true, verification: true } });
    expect(record.seller.payToAddress).toBe(env.SELLER_B_PAY_TO);
    expect(verificationSummary(normalizeRegistryService(record), record.verification).status).toBe("BINDING_CHANGED");
    expect(await prisma!.serviceVerification.findUnique({ where: { serviceId: "credit-report-a" } })).toBeNull();
    const events = await prisma!.auditEvent.findMany({ where: { aggregateType: "SERVICE" }, orderBy: { sequence: "asc" } });
    expect(events).toHaveLength(2);
    expect(events[1]?.payload).toMatchObject({ operation: "APPROVED_SELLER_WALLET_ROTATION",
      previousPayTo: env.SELLER_B_PREVIOUS_PAY_TO, payTo: env.SELLER_B_PAY_TO,
      automaticCertification: false, historicalPurchasesChanged: false });
  });
});
