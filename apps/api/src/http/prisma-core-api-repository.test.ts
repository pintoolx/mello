import type { PrismaClient } from "@mello/db";
import { BASE_SEPOLIA_USDC, MELLO_NETWORK, type MelloError } from "@mello/shared";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import {
  deliveryEvidenceForResponse,
  explorerLinksForPurchase,
  PrismaCoreApiRepository,
} from "./prisma-core-api-repository.js";

describe("purchase delivery evidence", () => {
  it("keeps a quarantined report out of API output until delivery is promoted", () => {
    const report = { reportId: "quarantined" };
    expect(
      deliveryEvidenceForResponse({ status: "PENDING", responseBody: report }),
    ).toEqual({ status: "PENDING", responseBody: null });
    expect(
      deliveryEvidenceForResponse({ status: "DELIVERED", responseBody: report }),
    ).toEqual({ status: "DELIVERED", responseBody: report });
  });
});

function successfulOperation(
  calls: string[],
  name: string,
  result: unknown = { count: 1 },
): ReturnType<typeof vi.fn> {
  return vi.fn(async () => {
    calls.push(name);
    return result;
  });
}

describe("PrismaCoreApiRepository demo reset", () => {
  it("rejects reset under the exclusive queue lock when a durable job is active", async () => {
    const transaction = {
      $queryRaw: vi.fn(async () => [{ acquired: false }]),
      workflowJob: { count: vi.fn(async () => 1) },
    };
    const prisma = {
      $transaction: vi.fn(
        async (operation: (client: typeof transaction) => Promise<unknown>) =>
          operation(transaction),
      ),
    } as unknown as PrismaClient;
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://mello:mello@localhost:5432/mello_test",
    });

    const result = new PrismaCoreApiRepository(prisma, config).resetDemo();

    await expect(result).rejects.toMatchObject({
      code: "TASK_ALREADY_RUNNING",
      statusCode: 409,
    } satisfies Partial<MelloError>);
    expect(transaction.$queryRaw).toHaveBeenCalledOnce();
  });

  it("deletes workflow data in dependency order and restores config-backed seed data", async () => {
    const calls: string[] = [];
    const transaction = {
      $queryRaw: successfulOperation(calls, "lock workflow queue", []),
      workflowJob: {
        count: successfulOperation(calls, "count active workflow jobs", 0),
        deleteMany: successfulOperation(calls, "delete workflow jobs"),
      },
      auditEvent: {
        deleteMany: successfulOperation(calls, "delete audit events", { count: 2 }),
        create: successfulOperation(calls, "create reset event", { id: "event-reset" }),
      },
      sellerPaymentCache: {
        deleteMany: successfulOperation(calls, "delete seller payment cache", { count: 3 }),
      },
      purchase: { deleteMany: successfulOperation(calls, "delete purchases", { count: 4 }) },
      task: { deleteMany: successfulOperation(calls, "delete tasks", { count: 5 }) },
      service: {
        deleteMany: successfulOperation(calls, "delete services"),
        createMany: successfulOperation(calls, "create services", { count: 2 }),
      },
      seller: {
        deleteMany: successfulOperation(calls, "delete sellers"),
        createMany: successfulOperation(calls, "create sellers", { count: 2 }),
      },
      policy: {
        deleteMany: successfulOperation(calls, "delete policies"),
        create: successfulOperation(calls, "create policy", { id: "policy" }),
      },
      companyProfile: {
        deleteMany: successfulOperation(calls, "delete company"),
        create: successfulOperation(calls, "create company", { id: "company" }),
      },
    };
    const prisma = {
      $transaction: vi.fn(
        async (operation: (client: typeof transaction) => Promise<unknown>) =>
          operation(transaction),
      ),
    } as unknown as PrismaClient;
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://mello:mello@localhost:5432/mello_test",
      SELLER_A_URL: "http://localhost:5011/",
      SELLER_B_URL: "http://localhost:5012/",
      SELLER_A_PAY_TO: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      SELLER_B_PAY_TO: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });

    const result = await new PrismaCoreApiRepository(prisma, config).resetDemo();

    expect(calls.indexOf("delete purchases")).toBeLessThan(calls.indexOf("delete tasks"));
    expect(calls.indexOf("lock workflow queue")).toBeLessThan(
      calls.indexOf("delete workflow jobs"),
    );
    expect(calls.indexOf("delete tasks")).toBeLessThan(calls.indexOf("delete services"));
    expect(calls.indexOf("delete services")).toBeLessThan(calls.indexOf("delete sellers"));
    expect(calls.indexOf("delete company")).toBeLessThan(calls.indexOf("create company"));
    expect(transaction.seller.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          id: "seller-a",
          payToAddress: config.SELLER_A_PAY_TO,
        }),
        expect.objectContaining({
          id: "seller-b",
          payToAddress: config.SELLER_B_PAY_TO,
        }),
      ]),
    });
    expect(transaction.service.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          id: "credit-report-a",
          endpoint: "http://localhost:5011/v1/credit-report",
        }),
        expect.objectContaining({
          id: "credit-report-b",
          endpoint: "http://localhost:5012/v1/credit-report",
        }),
      ]),
    });
    expect(result).toMatchObject({
      status: "RESET",
      deleted: {
        auditEvents: 2,
        sellerPaymentCache: 3,
        purchases: 4,
        tasks: 5,
      },
      seeded: {
        sellers: ["seller-a", "seller-b"],
        services: ["credit-report-a", "credit-report-b"],
      },
    });
  });

  it("preserves a conclusive pre-release FAILED state after background finalization", async () => {
    const taskUpdateMany = vi.fn(async () => ({ count: 1 }));
    const purchaseUpdateMany = vi.fn(async () => ({ count: 1 }));
    const auditCreate = vi.fn(async () => ({ id: "event-1" }));
    const transaction = {
      $queryRaw: vi.fn(async () => [{ acquired: true }]),
      task: {
        findUnique: vi.fn(async () => ({
          id: "00000000-0000-4000-8000-000000000101",
          status: "FAILED",
          purchase: {
            id: "00000000-0000-4000-8000-000000000102",
            status: "FAILED",
            payment: { status: "FAILED" },
            authorization: { status: "REJECTED" },
          },
        })),
        updateMany: taskUpdateMany,
      },
      purchase: { updateMany: purchaseUpdateMany },
      auditEvent: {
        findFirst: vi.fn(async () => null),
        create: auditCreate,
      },
    };
    const prisma = {
      $transaction: vi.fn(
        async (operation: (client: typeof transaction) => Promise<unknown>) =>
          operation(transaction),
      ),
    } as unknown as PrismaClient;
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://mello:mello@localhost:5432/mello_test",
    });

    await new PrismaCoreApiRepository(prisma, config).recordBackgroundFailure({
      operation: "RUN_TASK",
      taskId: "00000000-0000-4000-8000-000000000101",
      purchaseId: "00000000-0000-4000-8000-000000000102",
      requestId: "request-terminal-failure",
      error: new Error("pre-release request failed"),
    });

    expect(taskUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "00000000-0000-4000-8000-000000000101",
        status: "FAILED",
      },
      data: expect.objectContaining({ status: "FAILED" }),
    });
    expect(purchaseUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "00000000-0000-4000-8000-000000000102",
        status: "FAILED",
      },
      data: { status: "FAILED" },
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        stage: "FAILED_FINAL",
        payload: expect.objectContaining({
          terminalFailurePreserved: true,
          automaticRepaymentAllowed: false,
        }),
      }),
    });
  });

  it("marks an interrupted post-CREATED run ACTION_REQUIRED without allowing repayment", async () => {
    const taskUpdateMany = vi.fn(async () => ({ count: 1 }));
    const purchaseUpdateMany = vi.fn(async () => ({ count: 1 }));
    const auditCreate = vi.fn(async () => ({ id: "event-1" }));
    const transaction = {
      $queryRaw: vi.fn(async () => [{ acquired: true }]),
      task: {
        findUnique: vi.fn(async () => ({
          id: "00000000-0000-4000-8000-000000000101",
          status: "PAYING",
          purchase: {
            id: "00000000-0000-4000-8000-000000000102",
            status: "PAYING",
            payment: { status: "SETTLEMENT_PENDING" },
            authorization: { status: "SUBMITTED" },
          },
        })),
        updateMany: taskUpdateMany,
      },
      purchase: { updateMany: purchaseUpdateMany },
      auditEvent: {
        findFirst: vi.fn(async () => null),
        create: auditCreate,
      },
    };
    const prisma = {
      $transaction: vi.fn(
        async (operation: (client: typeof transaction) => Promise<unknown>) =>
          operation(transaction),
      ),
    } as unknown as PrismaClient;
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://mello:mello@localhost:5432/mello_test",
    });

    await new PrismaCoreApiRepository(prisma, config).recordBackgroundFailure({
      operation: "RUN_TASK",
      taskId: "00000000-0000-4000-8000-000000000101",
      purchaseId: "00000000-0000-4000-8000-000000000102",
      requestId: "request-crash-recovery",
      error: new Error(
        "worker lease exhausted at postgresql://mello:DB_SENTINEL@localhost/mello " +
          "with Bearer BEARER_SENTINEL",
      ),
    });

    expect(taskUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "00000000-0000-4000-8000-000000000101",
        status: "PAYING",
      },
      data: expect.objectContaining({
        status: "ACTION_REQUIRED",
        errorMessage:
          "worker lease exhausted at postgresql://[REDACTED]@localhost/mello " +
          "with [REDACTED]",
      }),
    });
    expect(purchaseUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "00000000-0000-4000-8000-000000000102",
        status: "PAYING",
      },
      data: { status: "ACTION_REQUIRED" },
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "BACKGROUND_RUN_TASK_FAILED_FINAL",
        payload: expect.objectContaining({ automaticRepaymentAllowed: false }),
      }),
    });
  });
});

describe("PrismaCoreApiRepository audit ordering", () => {
  it("orders the public audit feed by its database-assigned sequence", async () => {
    const findMany = vi.fn(async () => []);
    const prisma = {
      auditEvent: {
        findMany,
        count: vi.fn(async () => 0),
      },
    } as unknown as PrismaClient;
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://mello:mello@localhost:5432/mello_test",
    });

    await new PrismaCoreApiRepository(prisma, config).listAuditEvents({
      limit: 25,
      offset: 0,
    });

    expect(findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { sequence: "asc" },
      take: 25,
      skip: 0,
    });
  });
});

describe("purchase evidence links", () => {
  it("never turns historical mock hashes into explorer links after a runtime switch", () => {
    expect(
      explorerLinksForPurchase({
        paymentExplorerBase: null,
        anchorExplorerBase: null,
      }),
    ).toEqual({ payment: null, anchor: null });
  });

  it("uses only explorer provenance captured on the purchase", () => {
    expect(
      explorerLinksForPurchase({
        paymentExplorerBase: "https://sepolia.basescan.org",
        anchorExplorerBase: "https://sepolia.basescan.org",
      }),
    ).toEqual({
      payment: "https://sepolia.basescan.org",
      anchor: "https://sepolia.basescan.org",
    });
  });
});

describe("historical purchase payee", () => {
  it("keeps the purchase payee snapshot when the registry seller wallet rotates", async () => {
    const originalPayTo = "0x1111111111111111111111111111111111111111";
    const rotatedPayTo = "0x2222222222222222222222222222222222222222";
    const service = {
      id: "credit-report-b",
      sellerId: "seller-b",
      category: "credit_report",
      endpoint: "https://seller.example/v1/credit-report",
      method: "POST",
      priceAtomic: "50000",
      tokenSymbol: "USDC",
      tokenAddress: BASE_SEPOLIA_USDC,
      tokenDecimals: 6,
      network: MELLO_NETWORK,
      supportsTwInvoice: true,
      active: true,
      seller: {
        legalName: "Demo Seller B",
        businessId: "12345675",
        payToAddress: originalPayTo,
        invoiceCapability: "TW_B2B_DEMO",
        invoiceProvider: "MOCK",
      },
    };
    const purchase = {
      id: "00000000-0000-4000-8000-000000000102",
      taskId: "00000000-0000-4000-8000-000000000101",
      status: "COMPLETED",
      task: { prompt: "buy a report" },
      service,
      payToAddress: originalPayTo,
      paymentExplorerBase: null,
      anchorExplorerBase: null,
      authorization: null,
      payment: null,
      delivery: null,
      invoice: null,
      anchors: [],
    };
    const prisma = {
      purchase: { findUnique: vi.fn(async () => purchase) },
      auditEvent: { findMany: vi.fn(async () => []) },
      service: { findMany: vi.fn(async () => [service]) },
    } as unknown as PrismaClient;
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://mello:mello@localhost:5432/mello_test",
    });
    const repository = new PrismaCoreApiRepository(prisma, config);

    const beforeRotation = await repository.getPurchaseDetail(purchase.id);
    service.seller.payToAddress = rotatedPayTo;
    const afterRotation = await repository.getPurchaseDetail(purchase.id);

    expect(afterRotation).toEqual(beforeRotation);
    expect(afterRotation).toMatchObject({
      payToAddress: originalPayTo,
      selectedService: { payToAddress: originalPayTo },
    });
    expect(await repository.listServices()).toEqual([
      expect.objectContaining({ payToAddress: rotatedPayTo }),
    ]);
    expect(service.seller.payToAddress).toBe(rotatedPayTo);
  });
});

describe("public task errors", () => {
  it("redacts credentials from legacy persisted error messages", async () => {
    const prisma = {
      task: {
        findMany: vi.fn(async () => [
          {
            id: "00000000-0000-4000-8000-000000000101",
            prompt: "buy a report",
            status: "FAILED",
            decisionSummary: null,
            errorCode: "INTERNAL_ERROR",
            errorMessage:
              "database postgresql://mello:DB_SENTINEL@localhost/mello " +
              "Bearer BEARER_SENTINEL",
            usedFallbackParser: false,
            createdAt: new Date(),
            updatedAt: new Date(),
            completedAt: null,
            purchase: null,
          },
        ]),
        count: vi.fn(async () => 1),
      },
    } as unknown as PrismaClient;
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://mello:mello@localhost:5432/mello_test",
    });

    const result = await new PrismaCoreApiRepository(prisma, config).listTasks({
      limit: 20,
      offset: 0,
    });

    expect(JSON.stringify(result)).toContain("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain("DB_SENTINEL");
    expect(JSON.stringify(result)).not.toContain("BEARER_SENTINEL");
  });
});

describe("dashboard settlement totals", () => {
  it("does not mix historical mock settlements into an x402 runtime total", async () => {
    const paymentFindMany = vi.fn(async () => [{ amountAtomic: "50000" }]);
    const prisma = {
      task: { findMany: vi.fn(async () => []) },
      purchase: {
        findMany: vi.fn(async () => []),
        count: vi.fn(async () => 0),
      },
      payment: { findMany: paymentFindMany },
    } as unknown as PrismaClient;
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://mello:mello@localhost:5432/mello_test",
      PAYMENT_MODE: "x402",
      EVM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
      SELLER_CONTEXT_HMAC_SECRET: "test-only-random-context-secret-32-bytes",
    });

    await new PrismaCoreApiRepository(prisma, config).getDashboardSummary();

    expect(paymentFindMany).toHaveBeenCalledWith({
      where: { status: "SETTLED", purchase: { paymentMode: "x402" } },
      select: { amountAtomic: true },
    });
  });
});
