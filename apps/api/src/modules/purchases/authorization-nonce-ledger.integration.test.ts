import { randomUUID } from "node:crypto";
import { prisma } from "@mello/db";
import { BASE_SEPOLIA_USDC, DEMO_COMPANY_ID, MELLO_NETWORK } from "@mello/shared";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { withAuthorizationNonceReservation } from "./authorization-nonce-ledger.js";

const RUN_INTEGRATION_TESTS =
  process.env["RUN_INTEGRATION_TESTS"] === "true" ||
  process.env["RUN_AUTHORIZATION_NONCE_INTEGRATION_TESTS"] === "true";

const BUYER = "0x9999999999999999999999999999999999999999";
const SELLER_ADDRESS = "0x2222222222222222222222222222222222222222";
const NOW = new Date("2030-01-01T00:00:00.000Z");
const nonce = (character: string): string => `0x${character.repeat(64)}`;

const fixtureIds = {
  companies: [] as string[],
  sellers: [] as string[],
  services: [] as string[],
  tasks: [] as string[],
  purchases: [] as string[],
};

interface PurchaseFixture {
  companyId: string;
  purchaseId: string;
  paymentId: string;
}

async function createPurchaseFixture(existingCompanyId = DEMO_COMPANY_ID): Promise<PurchaseFixture> {
  const companyId = existingCompanyId;
  const sellerId = `nonce-seller-${randomUUID()}`;
  const serviceId = `nonce-service-${randomUUID()}`;
  const taskId = randomUUID();
  const purchaseId = randomUUID();
  const paymentId = `payment-${randomUUID()}`;
  fixtureIds.sellers.push(sellerId);
  fixtureIds.services.push(serviceId);
  fixtureIds.tasks.push(taskId);
  fixtureIds.purchases.push(purchaseId);
  await prisma.seller.create({
    data: {
      id: sellerId,
      legalName: "Nonce Ledger Test Seller",
      payToAddress: SELLER_ADDRESS,
      invoiceCapability: "NONE",
      invoiceProvider: "NONE",
    },
  });
  await prisma.service.create({
    data: {
      id: serviceId,
      sellerId,
      category: "credit_report",
      endpoint: "http://127.0.0.1:9/nonce-test",
      method: "POST",
      priceAtomic: "50000",
      tokenSymbol: "USDC",
      tokenAddress: BASE_SEPOLIA_USDC,
      tokenDecimals: 6,
      network: MELLO_NETWORK,
      supportsTwInvoice: false,
    },
  });
  await prisma.task.create({ data: { id: taskId, prompt: "nonce ledger integration" } });
  await prisma.purchase.create({
    data: {
      id: purchaseId,
      taskId,
      buyerProfileId: companyId,
      serviceId,
      paymentId,
      expectedAmountAtomic: "50000",
      network: MELLO_NETWORK,
      tokenSymbol: "USDC",
      tokenAddress: BASE_SEPOLIA_USDC,
      tokenDecimals: 6,
      buyerAddress: BUYER,
      payToAddress: SELLER_ADDRESS,
      policySnapshot: {},
      mandateHash: nonce("1"),
      policyHash: nonce("2"),
      expiresAt: new Date(NOW.getTime() + 600_000),
    },
  });
  return { companyId, purchaseId, paymentId };
}

function authorizationData(input: PurchaseFixture & { nonce: string; typedDataHash: string }) {
  return {
    paymentId: input.paymentId,
    standard: "ERC3009",
    scheme: "exact",
    network: MELLO_NETWORK,
    tokenAddress: BASE_SEPOLIA_USDC,
    fromAddress: BUYER,
    toAddress: SELLER_ADDRESS,
    amountAtomic: "50000",
    nonce: input.nonce.toLowerCase(),
    validAfter: 1n,
    validBefore: 300n,
    eip712Name: "USD Coin",
    eip712Version: "2",
    eip712ChainId: 84532n,
    typedDataHash: input.typedDataHash,
    signatureHash: null,
    status: "CREATED" as const,
    settlementTxHash: null,
  };
}

async function replaceAuthorization(
  fixture: PurchaseFixture,
  nextNonce: string,
  typedDataHash: string,
): Promise<void> {
  await withAuthorizationNonceReservation(
    prisma,
    {
      ...fixture,
      nonce: nextNonce,
      typedDataHash,
      createdAt: NOW,
    },
    async (transaction, normalizedNonce) => {
      const data = authorizationData({
        ...fixture,
        nonce: normalizedNonce,
        typedDataHash,
      });
      await transaction.paymentAuthorization.upsert({
        where: { purchaseId: fixture.purchaseId },
        create: { purchaseId: fixture.purchaseId, ...data },
        update: data,
      });
    },
  );
}

async function cleanup(): Promise<void> {
  if (fixtureIds.purchases.length > 0) {
    await prisma.purchase.deleteMany({ where: { id: { in: fixtureIds.purchases } } });
  }
  if (fixtureIds.tasks.length > 0) {
    await prisma.auditEvent.deleteMany({ where: { taskId: { in: fixtureIds.tasks } } });
    await prisma.task.deleteMany({ where: { id: { in: fixtureIds.tasks } } });
  }
  if (fixtureIds.services.length > 0) {
    await prisma.service.deleteMany({ where: { id: { in: fixtureIds.services } } });
  }
  if (fixtureIds.sellers.length > 0) {
    await prisma.seller.deleteMany({ where: { id: { in: fixtureIds.sellers } } });
  }
  if (fixtureIds.companies.length > 0) {
    await prisma.companyProfile.deleteMany({ where: { id: { in: fixtureIds.companies } } });
  }
  for (const ids of Object.values(fixtureIds)) ids.splice(0, ids.length);
}

describe.skipIf(!RUN_INTEGRATION_TESTS).sequential(
  "ERC-3009 authorization nonce PostgreSQL ledger",
  () => {
    afterEach(cleanup);
    afterAll(async () => prisma.$disconnect());

    it("rejects A -> B -> A replay and leaves B as current evidence", async () => {
      const fixture = await createPurchaseFixture();
      await replaceAuthorization(fixture, nonce("a"), nonce("3"));
      await replaceAuthorization(fixture, nonce("b"), nonce("4"));

      await expect(
        replaceAuthorization(fixture, nonce("A"), nonce("5")),
      ).rejects.toMatchObject({
        code: "ERC3009_NONCE_REUSED",
        statusCode: 409,
        retryable: false,
      });

      const [current, history] = await Promise.all([
        prisma.paymentAuthorization.findUniqueOrThrow({
          where: { purchaseId: fixture.purchaseId },
        }),
        prisma.paymentAuthorizationNonce.findMany({
          where: { purchaseId: fixture.purchaseId },
          orderBy: { nonce: "asc" },
        }),
      ]);
      expect(current).toMatchObject({
        paymentId: fixture.paymentId,
        nonce: nonce("b"),
        typedDataHash: nonce("4"),
      });
      expect(history.map(({ nonce: recorded }) => recorded)).toEqual([
        nonce("a"),
        nonce("b"),
      ]);
      expect(new Set(history.map(({ paymentId }) => paymentId))).toEqual(
        new Set([fixture.paymentId]),
      );

      await prisma.purchase.delete({ where: { id: fixture.purchaseId } });
      await expect(
        prisma.paymentAuthorizationNonce.count({
          where: { purchaseId: fixture.purchaseId },
        }),
      ).resolves.toBe(0);
    });

    it("allows only one concurrent claimant for a globally unique nonce", async () => {
      const first = await createPurchaseFixture();
      const second = await createPurchaseFixture(first.companyId);
      const sharedNonce = nonce("c");

      const outcomes = await Promise.allSettled([
        replaceAuthorization(first, sharedNonce, nonce("6")),
        replaceAuthorization(second, sharedNonce, nonce("7")),
      ]);

      expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      const rejected = outcomes.find(({ status }) => status === "rejected");
      expect(rejected?.status).toBe("rejected");
      if (!rejected || rejected.status !== "rejected") {
        throw new Error("Expected one concurrent nonce reservation to fail");
      }
      expect(rejected.reason).toMatchObject({ code: "ERC3009_NONCE_REUSED" });
      await expect(
        prisma.paymentAuthorizationNonce.count({ where: { nonce: sharedNonce } }),
      ).resolves.toBe(1);
      await expect(
        prisma.paymentAuthorization.count({
          where: { purchaseId: { in: [first.purchaseId, second.purchaseId] } },
        }),
      ).resolves.toBe(1);
    });

    it("rejects a ledger paymentId that belongs to a different Purchase", async () => {
      const first = await createPurchaseFixture();
      const second = await createPurchaseFixture(first.companyId);

      await expect(
        prisma.paymentAuthorizationNonce.create({
          data: {
            purchaseId: first.purchaseId,
            paymentId: second.paymentId,
            nonce: nonce("d"),
            typedDataHash: nonce("8"),
            createdAt: NOW,
          },
        }),
      ).rejects.toMatchObject({ code: "P2003" });

      await expect(
        prisma.paymentAuthorizationNonce.count({ where: { nonce: nonce("d") } }),
      ).resolves.toBe(0);
    });
  },
);
