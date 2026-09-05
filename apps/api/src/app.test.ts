import {
  BASE_SEPOLIA_USDC,
  MELLO_NETWORK,
  MelloError,
  type CompanyProfileInput,
  type PolicyInput,
} from "@mello/shared";
import type { Logger } from "pino";
import supertest from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { createCoreApiDependencies } from "./bootstrap.js";
import { loadConfig, type AppConfig } from "./config.js";
import type {
  CoreApiDependencies,
  CoreApiRepository,
  HealthService,
  PurchaseRetryState,
  TaskExecutionState,
  WorkflowOperations,
} from "./http/contracts.js";
import type {
  EnqueueWorkflowJobInput,
  WorkflowJobPoller,
  WorkflowJobQueue,
} from "./modules/workflow-jobs/index.js";

const TASK_ID = "00000000-0000-4000-8000-000000000101";
const HTTP_API_KEY = "http-app-unit-test-only-private-api-key";
const PURCHASE_ID = "00000000-0000-4000-8000-000000000102";
const COMPANY: CompanyProfileInput & { id: string } = {
  id: "00000000-0000-4000-8000-000000000001",
  legalName: "Mello Demo Corp.",
  businessId: "12345675",
  email: "finance@example.test",
  defaultCostCenter: "RISK-DATA",
};
const POLICY: PolicyInput & { id: string; version: number; active: boolean } = {
  id: "00000000-0000-4000-8000-000000000002",
  version: 1,
  perTxLimitAtomic: "100000",
  dailyLimitAtomic: "1000000",
  requireTwInvoice: true,
  allowedNetworks: [MELLO_NETWORK],
  allowedTokens: [{ symbol: "USDC", address: BASE_SEPOLIA_USDC, decimals: 6 }],
  allowedSellerIds: ["seller-a", "seller-b"],
  active: true,
};

function testConfig(nodeEnvironment: "test" | "production" = "test"): AppConfig {
  return loadConfig({
    NODE_ENV: nodeEnvironment,
    ...(nodeEnvironment === "production" ? { API_ACCESS_TOKEN: HTTP_API_KEY } : {}),
    DATABASE_URL: "postgresql://mello:mello@localhost:5432/mello_test",
    DEMO_ADMIN_TOKEN: "api-route-test-fixture-only",
  });
}

function fakeRepository(): CoreApiRepository {
  return {
    getCompany: vi.fn(async () => COMPANY),
    saveCompany: vi.fn(async (input) => ({ ...COMPANY, ...input })),
    getActivePolicy: vi.fn(async () => POLICY),
    replaceActivePolicy: vi.fn(async (input) => ({
      ...POLICY,
      ...input,
      id: "00000000-0000-4000-8000-000000000003",
      version: 2,
    })),
    listSellers: vi.fn(async () => [{ id: "seller-a" }, { id: "seller-b" }]),
    listServices: vi.fn(async () => [{ id: "credit-report-a" }, { id: "credit-report-b" }]),
    createTask: vi.fn(
      async (): Promise<{ id: string; status: "CREATED" }> => ({
        id: TASK_ID,
        status: "CREATED",
      }),
    ),
    listTasks: vi.fn(async ({ limit, offset }) => ({
      items: [{ taskId: TASK_ID, status: "CREATED" }],
      total: 1,
      limit,
      offset,
    })),
    getTaskExecutionState: vi.fn(
      async (): Promise<TaskExecutionState | null> => ({
        id: TASK_ID,
        status: "CREATED",
        purchaseId: null,
      }),
    ),
    getTaskDetail: vi.fn(async () => ({ taskId: TASK_ID, status: "CREATED" })),
    listPurchases: vi.fn(async ({ limit, offset }) => ({
      items: [{ purchaseId: PURCHASE_ID, status: "COMPLETED" }],
      total: 1,
      limit,
      offset,
    })),
    getPurchaseDetail: vi.fn(async () => ({
      purchaseId: PURCHASE_ID,
      status: "COMPLETED",
      paymentAuthorization: { validBefore: 123n },
      anchors: [{ blockNumber: 42n }],
    })),
    getPurchaseRetryState: vi.fn(
      async (): Promise<PurchaseRetryState | null> => ({
        id: PURCHASE_ID,
        taskId: TASK_ID,
        invoiceRetryable: true,
        anchorRetryable: true,
        anchorPendingStatus: "FINAL_ANCHOR_PENDING",
        paymentReconciliationAvailable: true,
      }),
    ),
    listAuditEvents: vi.fn(async ({ limit, offset }) => ({
      items: [{ id: "event-1", eventType: "TASK_CREATED" }],
      total: 1,
      limit,
      offset,
    })),
    getDashboardSummary: vi.fn(async () => ({ counts: { tasks: 1 } })),
    resetDemo: vi.fn(async () => ({
      status: "RESET",
      seeded: { sellers: ["seller-a", "seller-b"] },
    })),
    recordBackgroundFailure: vi.fn(async () => undefined),
  };
}

function fakeWorkflow(): WorkflowOperations {
  return {
    run: vi.fn(async () => undefined),
    retryInvoice: vi.fn(async () => undefined),
    retryAnchor: vi.fn(async () => undefined),
    reconcilePayment: vi.fn(async () => undefined),
  };
}

function fakeWorkflowJobs(): WorkflowJobQueue {
  const activeKeys = new Set<string>();
  return {
    enqueue: vi.fn(async (input: EnqueueWorkflowJobInput) => {
      const key = `${input.kind}:${input.aggregateId}`;
      if (activeKeys.has(key)) {
        throw new MelloError(
          "TASK_ALREADY_RUNNING",
          "Workflow operation is already queued or running",
          { statusCode: 409 },
        );
      }
      activeKeys.add(key);
      return { id: `job-${activeKeys.size}` };
    }),
    hasActiveJobs: vi.fn(async () => activeKeys.size > 0),
  };
}

function fakeWorkflowJobPoller(): WorkflowJobPoller {
  return {
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
    runOnce: vi.fn(async () => false),
  };
}

function fakeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function dependencies(
  overrides: Partial<CoreApiDependencies> = {},
): CoreApiDependencies {
  const healthService: HealthService = {
    check: vi.fn(async () => ({ status: "ok", checkedAt: "2026-09-04T00:00:00.000Z" })),
  };
  return {
    config: testConfig(),
    repository: fakeRepository(),
    workflow: fakeWorkflow(),
    healthService,
    logger: fakeLogger(),
    workflowJobs: fakeWorkflowJobs(),
    workflowJobPoller: fakeWorkflowJobPoller(),
    ...overrides,
  };
}

describe("Core API HTTP app", () => {
  it("refuses the published placeholder admin token in production", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      API_ACCESS_TOKEN: HTTP_API_KEY,
      DATABASE_URL: "postgresql://mello:mello@localhost:5432/mello",
    });

    expect(() => createCoreApiDependencies({ config })).toThrow(
      "DEMO_ADMIN_TOKEN must be changed before a production deployment",
    );
  });

  it("returns health with a stable request ID", async () => {
    const app = createApp(dependencies());
    const response = await supertest(app)
      .get("/api/v1/demo/health")
      .set("x-request-id", "request-health-1")
      .expect(200);

    expect(response.headers["x-request-id"]).toBe("request-health-1");
    expect(response.body).toMatchObject({ status: "ok" });
  });

  it("adds runtime modes to the dashboard summary", async () => {
    const response = await supertest(createApp(dependencies()))
      .get("/api/v1/dashboard/summary")
      .expect(200);

    expect(response.body).toMatchObject({
      counts: { tasks: 1 },
      modes: { agent: "demo", payment: "mock", invoice: "mock", anchor: "mock" },
    });
  });

  it("keeps settings readable to the BFF while requiring the admin token for mutations", async () => {
    const productionDependencies = dependencies({ config: testConfig("production") });
    const app = createApp(productionDependencies);

    const settings = await supertest(app).get("/api/v1/settings").set("x-mello-api-key", HTTP_API_KEY).expect(200);
    expect(settings.body).toMatchObject({
      company: { businessId: "12345675" },
      policy: { version: 1 },
    });

    const unauthorized = await supertest(app)
      .put("/api/v1/company")
      .set("x-mello-api-key", HTTP_API_KEY)
      .send({
        legalName: COMPANY.legalName,
        businessId: COMPANY.businessId,
        email: COMPANY.email,
        defaultCostCenter: COMPANY.defaultCostCenter,
      })
      .expect(401);
    expect(unauthorized.body.error).toMatchObject({
      code: "VALIDATION_ERROR",
      retryable: false,
    });

    await supertest(app)
      .put("/api/v1/policies/active")
      .set("x-mello-api-key", HTTP_API_KEY)
      .set("x-demo-admin-token", "wrong-admin-token")
      .send(POLICY)
      .expect(401);

    const authorized = await supertest(app)
      .put("/api/v1/company")
      .set("x-mello-api-key", HTTP_API_KEY)
      .set("x-demo-admin-token", "api-route-test-fixture-only")
      .send({
        legalName: COMPANY.legalName,
        businessId: COMPANY.businessId,
        email: COMPANY.email,
        defaultCostCenter: COMPANY.defaultCostCenter,
      })
      .expect(200);
    expect(authorized.body).toMatchObject({ businessId: "12345675" });
    expect(JSON.stringify(authorized.body)).not.toContain("api-route-test-fixture-only");
  });

  it("requires the admin token and a local database for demo reset", async () => {
    const repository = fakeRepository();
    const localApp = createApp(dependencies({ repository }));

    await supertest(localApp).post("/api/v1/demo/reset").expect(401);
    const reset = await supertest(localApp)
      .post("/api/v1/demo/reset")
      .set("x-demo-admin-token", "api-route-test-fixture-only")
      .expect(200);
    expect(reset.body).toMatchObject({ status: "RESET" });
    expect(repository.resetDemo).toHaveBeenCalledOnce();

    const remoteConfig = loadConfig({
      NODE_ENV: "production",
      API_ACCESS_TOKEN: HTTP_API_KEY,
      DATABASE_URL: "postgresql://mello:mello@db.example.com:5432/mello",
      DEMO_ADMIN_TOKEN: "api-route-test-fixture-only",
    });
    const remoteRepository = fakeRepository();
    const forbidden = await supertest(
      createApp(dependencies({ config: remoteConfig, repository: remoteRepository })),
    )
      .post("/api/v1/demo/reset")
      .set("x-mello-api-key", HTTP_API_KEY)
      .set("x-demo-admin-token", "api-route-test-fixture-only")
      .expect(403);
    expect(forbidden.body.error.message).toContain("local database");
    expect(remoteRepository.resetDemo).not.toHaveBeenCalled();

    const malformedRepository = fakeRepository();
    const malformedConfig: AppConfig = {
      ...testConfig(),
      DATABASE_URL: "not-a-database-url",
    };
    await supertest(
      createApp(dependencies({ config: malformedConfig, repository: malformedRepository })),
    )
      .post("/api/v1/demo/reset")
      .set("x-demo-admin-token", "api-route-test-fixture-only")
      .expect(403);
    expect(malformedRepository.resetDemo).not.toHaveBeenCalled();
  });

  it("validates and updates the company profile", async () => {
    const runtime = dependencies();
    const app = createApp(runtime);

    const invalid = await supertest(app)
      .put("/api/v1/company")
      .set("x-demo-admin-token", "api-route-test-fixture-only")
      .send({ ...COMPANY, businessId: "123" })
      .expect(400);
    expect(invalid.body.error.code).toBe("VALIDATION_ERROR");

    for (const invalidFields of [{ invoiceEmail: "invalid" }, { invoiceAddress: "x".repeat(256) }, { contactName: "x".repeat(101) }]) {
      await supertest(app).put("/api/v1/company")
        .set("x-demo-admin-token", "api-route-test-fixture-only")
        .send({ ...COMPANY, ...invalidFields }).expect(400);
    }

    const valid = await supertest(app)
      .put("/api/v1/company")
      .set("x-demo-admin-token", "api-route-test-fixture-only")
      .send({
        legalName: COMPANY.legalName,
        businessId: COMPANY.businessId,
        email: COMPANY.email,
        defaultCostCenter: COMPANY.defaultCostCenter,
        invoiceEmail: "invoices@example.test",
        invoiceAddress: "台北市信義區",
        contactName: "財務聯絡人",
      })
      .expect(200);
    expect(valid.body.businessId).toBe("12345675");
    expect(valid.body).toMatchObject({ invoiceEmail: "invoices@example.test", invoiceAddress: "台北市信義區", contactName: "財務聯絡人" });
    expect(runtime.repository.saveCompany).toHaveBeenCalledOnce();
  });

  it("enforces the fixed P0 network and token when versioning policy", async () => {
    const runtime = dependencies();
    const app = createApp(runtime);
    const invalid = await supertest(app)
      .put("/api/v1/policies/active")
      .set("x-demo-admin-token", "api-route-test-fixture-only")
      .send({
        ...POLICY,
        allowedTokens: [
          { symbol: "USDC", address: "0x1111111111111111111111111111111111111111", decimals: 6 },
        ],
      })
      .expect(400);
    expect(invalid.body.error.code).toBe("VALIDATION_ERROR");

    const valid = await supertest(app)
      .put("/api/v1/policies/active")
      .set("x-demo-admin-token", "api-route-test-fixture-only")
      .send(POLICY)
      .expect(200);
    expect(valid.body.version).toBe(2);
    expect(runtime.repository.replaceActivePolicy).toHaveBeenCalledOnce();
  });

  it("creates, lists, and reads tasks", async () => {
    const app = createApp(dependencies());
    const created = await supertest(app)
      .post("/api/v1/tasks")
      .send({ prompt: "幫我買一份 Example Co. 的信用報告" })
      .expect(201);
    expect(created.body).toEqual({ taskId: TASK_ID, status: "CREATED" });

    const list = await supertest(app).get("/api/v1/tasks?limit=5&offset=0").expect(200);
    expect(list.body).toMatchObject({ total: 1, limit: 5, offset: 0 });

    const detail = await supertest(app).get(`/api/v1/tasks/${TASK_ID}`).expect(200);
    expect(detail.body.taskId).toBe(TASK_ID);
  });

  it("lists the seeded seller and service registry", async () => {
    const runtime = dependencies();
    const app = createApp(runtime);
    const sellers = await supertest(app).get("/api/v1/sellers").expect(200);
    const services = await supertest(app)
      .get("/api/v1/services?category=credit_report")
      .expect(200);

    expect(sellers.body.sellers).toHaveLength(2);
    expect(services.body.services).toHaveLength(2);
    expect(runtime.repository.listServices).toHaveBeenCalledWith("credit_report");
  });

  it("starts a created task in the background and returns 202", async () => {
    const runtime = dependencies();
    const response = await supertest(createApp(runtime))
      .post(`/api/v1/tasks/${TASK_ID}/run`)
      .set("x-request-id", "request-run-1")
      .expect(202);

    expect(response.body).toEqual({ taskId: TASK_ID, status: "PARSING" });
    expect(runtime.workflowJobs.enqueue).toHaveBeenCalledWith({
      kind: "RUN_TASK",
      aggregateId: TASK_ID,
      payload: { taskId: TASK_ID, requestId: "request-run-1" },
      maxAttempts: 3,
    });
    expect(runtime.workflow.run).not.toHaveBeenCalled();
  });

  it("rejects a second run while a task is active", async () => {
    const repository = fakeRepository();
    vi.mocked(repository.getTaskExecutionState).mockResolvedValue({
      id: TASK_ID,
      status: "PAYING",
      purchaseId: PURCHASE_ID,
    });
    const response = await supertest(createApp(dependencies({ repository })))
      .post(`/api/v1/tasks/${TASK_ID}/run`)
      .expect(409);

    expect(response.body.error.code).toBe("TASK_ALREADY_RUNNING");
  });

  it("rejects a duplicate run while the first launch is queued", async () => {
    const runtime = dependencies();
    const app = createApp(runtime);

    await supertest(app).post(`/api/v1/tasks/${TASK_ID}/run`).expect(202);
    const duplicate = await supertest(app)
      .post(`/api/v1/tasks/${TASK_ID}/run`)
      .expect(409);
    expect(duplicate.body.error.code).toBe("TASK_ALREADY_RUNNING");

  });

  it("does not reset while a background workflow is queued", async () => {
    const repository = fakeRepository();
    const runtime = dependencies({ repository });
    const app = createApp(runtime);

    await supertest(app).post(`/api/v1/tasks/${TASK_ID}/run`).expect(202);
    const conflict = await supertest(app)
      .post("/api/v1/demo/reset")
      .set("x-demo-admin-token", "api-route-test-fixture-only")
      .expect(409);
    expect(conflict.body.error.code).toBe("TASK_ALREADY_RUNNING");
    expect(repository.resetDemo).not.toHaveBeenCalled();
  });

  it("returns the existing result for a completed task", async () => {
    const repository = fakeRepository();
    vi.mocked(repository.getTaskExecutionState).mockResolvedValue({
      id: TASK_ID,
      status: "COMPLETED",
      purchaseId: PURCHASE_ID,
    });
    vi.mocked(repository.getTaskDetail).mockResolvedValue({
      taskId: TASK_ID,
      status: "COMPLETED",
      purchaseId: PURCHASE_ID,
    });
    const response = await supertest(createApp(dependencies({ repository })))
      .post(`/api/v1/tasks/${TASK_ID}/run`)
      .expect(200);

    expect(response.body.status).toBe("COMPLETED");
  });

  it("durably enqueues without running rejected workflow work in the HTTP request", async () => {
    const repository = fakeRepository();
    const workflow = fakeWorkflow();
    vi.mocked(workflow.run).mockRejectedValue(new Error("workflow exploded"));
    const runtime = dependencies({ repository, workflow });
    await supertest(createApp(runtime))
      .post(`/api/v1/tasks/${TASK_ID}/run`)
      .expect(202);

    expect(runtime.workflowJobs.enqueue).toHaveBeenCalledOnce();
    expect(workflow.run).not.toHaveBeenCalled();
    expect(repository.recordBackgroundFailure).not.toHaveBeenCalled();
  });

  it("serializes Prisma bigint values in purchase detail", async () => {
    const response = await supertest(createApp(dependencies()))
      .get(`/api/v1/purchases/${PURCHASE_ID}`)
      .expect(200);

    expect(response.body.paymentAuthorization.validBefore).toBe("123");
    expect(response.body.anchors[0].blockNumber).toBe("42");
  });

  it("schedules invoice and anchor retries from purchase endpoints", async () => {
    const runtime = dependencies();
    const app = createApp(runtime);
    await supertest(app)
      .post(`/api/v1/purchases/${PURCHASE_ID}/retry-invoice`)
      .expect(202);
    const anchor = await supertest(app)
      .post(`/api/v1/purchases/${PURCHASE_ID}/retry-anchor`)
      .expect(202);

    expect(runtime.workflowJobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "RETRY_INVOICE", aggregateId: PURCHASE_ID }),
    );
    expect(runtime.workflowJobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "RETRY_ANCHOR", aggregateId: PURCHASE_ID }),
    );
    expect(runtime.workflow.retryInvoice).not.toHaveBeenCalled();
    expect(runtime.workflow.retryAnchor).not.toHaveBeenCalled();
    expect(anchor.body.status).toBe("FINAL_ANCHOR_PENDING");
  });

  it("supports task-level retry aliases used by the demo UI", async () => {
    const repository = fakeRepository();
    vi.mocked(repository.getTaskExecutionState).mockResolvedValue({
      id: TASK_ID,
      status: "ACTION_REQUIRED",
      purchaseId: PURCHASE_ID,
    });
    const runtime = dependencies({ repository });
    const app = createApp(runtime);

    await supertest(app)
      .post(`/api/v1/tasks/${TASK_ID}/retry-invoice`)
      .expect(202);
    await supertest(app)
      .post(`/api/v1/tasks/${TASK_ID}/retry-anchor`)
      .expect(202);
    await supertest(app)
      .post(`/api/v1/tasks/${TASK_ID}/reconcile-payment`)
      .set("x-demo-admin-token", "api-route-test-fixture-only")
      .expect(202);

    expect(runtime.workflowJobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "RETRY_INVOICE", aggregateId: PURCHASE_ID }),
    );
    expect(runtime.workflowJobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "RETRY_ANCHOR", aggregateId: PURCHASE_ID }),
    );
    expect(runtime.workflowJobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "RECONCILE_PAYMENT", aggregateId: PURCHASE_ID }),
    );
  });

  it("requires operator authentication and queues receipt-only payment reconciliation", async () => {
    const runtime = dependencies();
    const app = createApp(runtime);

    await supertest(app)
      .post(`/api/v1/purchases/${PURCHASE_ID}/reconcile-payment`)
      .expect(401);
    const response = await supertest(app)
      .post(`/api/v1/purchases/${PURCHASE_ID}/reconcile-payment`)
      .set("x-demo-admin-token", "api-route-test-fixture-only")
      .expect(202);

    expect(response.body).toMatchObject({
      purchaseId: PURCHASE_ID,
      status: "PENDING_RECONCILIATION",
    });
    expect(runtime.workflowJobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "RECONCILE_PAYMENT", aggregateId: PURCHASE_ID }),
    );
    expect(runtime.workflow.reconcilePayment).not.toHaveBeenCalled();
  });

  it("rejects retry when the requested operation is unavailable", async () => {
    const repository = fakeRepository();
    vi.mocked(repository.getPurchaseRetryState).mockResolvedValue({
      id: PURCHASE_ID,
      taskId: TASK_ID,
      invoiceRetryable: false,
      anchorRetryable: false,
      anchorPendingStatus: null,
      paymentReconciliationAvailable: false,
    });
    const response = await supertest(createApp(dependencies({ repository })))
      .post(`/api/v1/purchases/${PURCHASE_ID}/retry-invoice`)
      .expect(409);

    expect(response.body.error.code).toBe("INVOICE_ISSUE_FAILED");
  });

  it("returns task events as the P0 JSON array and supports the audit ledger", async () => {
    const app = createApp(dependencies());
    const taskEvents = await supertest(app)
      .get(`/api/v1/tasks/${TASK_ID}/events`)
      .expect(200);
    expect(taskEvents.body).toEqual([{ id: "event-1", eventType: "TASK_CREATED" }]);

    const audit = await supertest(app)
      .get(`/api/v1/audit-events?taskId=${TASK_ID}&limit=10`)
      .expect(200);
    expect(audit.body).toMatchObject({ total: 1, limit: 10 });
  });

  it("uses one error shape for validation, not-found, and internal errors", async () => {
    const invalid = await supertest(createApp(dependencies()))
      .get("/api/v1/tasks/not-a-uuid")
      .expect(400);
    expect(invalid.body.error).toMatchObject({ code: "VALIDATION_ERROR" });

    const missing = await supertest(createApp(dependencies()))
      .get("/api/v1/does-not-exist")
      .expect(404);
    expect(missing.body.error).toMatchObject({ code: "NOT_FOUND" });

    const repository = fakeRepository();
    vi.mocked(repository.getDashboardSummary).mockRejectedValue(
      new Error("secret database detail"),
    );
    const internal = await supertest(createApp(dependencies({ repository })))
      .get("/api/v1/dashboard/summary")
      .expect(500);
    expect(internal.body.error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Unexpected server error",
    });
    expect(JSON.stringify(internal.body)).not.toContain("secret database detail");
  });

  it("redacts secrets from typed error messages and details", async () => {
    const repository = fakeRepository();
    vi.mocked(repository.getDashboardSummary).mockRejectedValue(
      new MelloError(
        "X402_PAYMENT_FAILED",
        "upstream https://api.example.invalid?api_key=URL_API_KEY_SENTINEL failed",
        {
          statusCode: 502,
          details: {
            database: "postgresql://mello:DB_SENTINEL@localhost/mello",
            credential: "Bearer BEARER_SENTINEL",
          },
        },
      ),
    );

    const response = await supertest(createApp(dependencies({ repository })))
      .get("/api/v1/dashboard/summary")
      .expect(502);

    expect(response.body.error).toMatchObject({
      code: "X402_PAYMENT_FAILED",
      message:
        "upstream https://api.example.invalid?api_key=[REDACTED] failed",
      details: {
        database: "postgresql://[REDACTED]@localhost/mello",
        credential: "[REDACTED]",
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /URL_API_KEY_SENTINEL|DB_SENTINEL|BEARER_SENTINEL/u,
    );
  });

  it("returns the unified error shape for oversized JSON", async () => {
    const response = await supertest(createApp(dependencies()))
      .post("/api/v1/tasks")
      .send({ prompt: "x".repeat(70_000) })
      .expect(413);

    expect(response.body.error).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Request body exceeds the 64 KB limit",
      retryable: false,
      requestId: expect.any(String),
    });
  });
});
