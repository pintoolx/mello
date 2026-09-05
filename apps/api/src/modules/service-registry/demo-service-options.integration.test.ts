import { prisma } from "@mello/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { registerDemoServiceOptions } from "./demo-service-options.js";
import { resourceFixture, resultFixture } from "./fixtures.js";
import { normalizeRegistryService, ServiceRegistry } from "./registry-service.js";

const optionIds: [string, string] = ["credit-report-c", "credit-report-d"];

describe.sequential("unreviewed demo service options", () => {
  afterEach(async () => {
    await prisma.auditEvent.deleteMany({ where: { aggregateId: { in: optionIds } } });
    await prisma.service.deleteMany({ where: { id: { in: optionIds } } });
  });
  afterAll(async () => prisma.$disconnect());

  it("adds two independent unreviewed entries and preserves existing services and policy", async () => {
    const before = await prisma.service.findMany({ where: { id: { in: ["credit-report-a", "credit-report-b"] } }, include: { verification: true }, orderBy: { id: "asc" } });
    const policy = await prisma.policy.findMany();
    const results = await Promise.all([registerDemoServiceOptions(prisma), registerDemoServiceOptions(prisma)]);
    expect(results.flatMap(r => r.created).sort()).toEqual(optionIds);
    const options = await prisma.service.findMany({ where: { id: { in: optionIds } }, include: { seller: true, verification: true }, orderBy: { id: "asc" } });
    expect(options.map(o => ({ id: o.id, invoice: o.supportsTwInvoice, provider: o.sellerId, verification: o.verification }))).toEqual([
      { id: optionIds[0], invoice: true, provider: "seller-b", verification: null },
      { id: optionIds[1], invoice: false, provider: "seller-a", verification: null },
    ]);
    expect(options[0]!.endpoint).toBe(before[1]!.endpoint);
    expect(options[1]!.endpoint).toBe(before[0]!.endpoint);
    expect(await prisma.service.findMany({ where: { id: { in: before.map(s => s.id) } }, include: { verification: true }, orderBy: { id: "asc" } })).toEqual(before);
    expect(await prisma.policy.findMany()).toEqual(policy);
    expect(await prisma.auditEvent.count({ where: { aggregateId: { in: optionIds }, eventType: "SERVICE_REGISTERED" } })).toBe(2);

    const resources = options.map(o => resourceFixture(normalizeRegistryService(o)));
    const registry = new ServiceRegistry(prisma, { search: vi.fn().mockResolvedValue(resultFixture(resources)) });
    const required = await registry.discover(true);
    const optional = await registry.discover(false);
    for (const id of optionIds) {
      expect(required.assessments.find(a => a.serviceId === id)).toMatchObject({ listed: true, verification: { status: "UNREVIEWED" }, reasonCodes: ["VERIFICATION_UNREVIEWED"] });
      expect(optional.assessments.find(a => a.serviceId === id)).toMatchObject({ listed: true, verification: { status: "UNREVIEWED" }, reasonCodes: [] });
    }
    expect(optional.services.find(s => s.id === optionIds[0])?.displayName).toBe("Mello 信用報告 C（Demo）");
  });

  it("preserves later changes and review decisions when registration runs again", async () => {
    await registerDemoServiceOptions(prisma);
    await prisma.service.update({ where: { id: optionIds[0] }, data: { displayName: "Later reviewed option", active: false } });
    await prisma.serviceVerification.create({ data: {
      serviceId: optionIds[0]!, status: "REVOKED", bindingHash: `0x${"00".repeat(32)}`,
      scopes: [], evidenceRef: "test:later-review", reviewedBy: "test-admin",
      reviewedAt: new Date(), expiresAt: new Date(Date.now() + 86400000), revokedAt: new Date(),
    } });
    const before = await prisma.service.findUniqueOrThrow({ where: { id: optionIds[0] }, include: { verification: true } });
    expect(await registerDemoServiceOptions(prisma)).toEqual({ created: [] });
    expect(await prisma.service.findUniqueOrThrow({ where: { id: optionIds[0] }, include: { verification: true } })).toEqual(before);
  });

  it("rolls the whole registration back when a requested ID belongs to another provider", async () => {
    const source = await prisma.service.findUniqueOrThrow({ where: { id: "credit-report-b" } });
    await prisma.service.create({ data: { ...source, id: optionIds[1]! } });
    await expect(registerDemoServiceOptions(prisma)).rejects.toThrow("Demo service ID belongs to another provider");
    expect(await prisma.service.findUnique({ where: { id: optionIds[0] } })).toBeNull();
    expect(await prisma.auditEvent.count({ where: { aggregateId: { in: optionIds }, eventType: "SERVICE_REGISTERED" } })).toBe(0);
  });
});
