import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  BASE_SEPOLIA_USDC,
  CompanyProfileInputSchema,
  CreateTaskSchema,
  ServiceSelectionSchema,
  MELLO_NETWORK,
  MelloError,
  PolicyInputSchema,
  redactSensitiveText,
  redactSensitiveValue,
} from "@mello/shared";
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import type {
  CoreApiDependencies,
  PurchaseRetryState,
} from "../http/contracts.js";
import { toJsonSafe } from "../http/json-safe.js";
import { UpdateServiceBindingSchema, VerifyServiceSchema } from "../modules/service-registry/verification.js";

const IdentifierParamsSchema = z.object({ id: z.uuid() });
const TaskIdentifierParamsSchema = z.object({ taskId: z.uuid() });
const PaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
const ServiceQuerySchema = z.object({
  category: z.literal("credit_report").optional(),
});
const AuditEventQuerySchema = PaginationSchema.extend({
  aggregateType: z.string().trim().min(1).max(32).optional(),
  aggregateId: z.string().trim().min(1).max(128).optional(),
  taskId: z.uuid().optional(),
  purchaseId: z.uuid().optional(),
});
const PolicyUpdateSchema = PolicyInputSchema.superRefine((policy, context) => {
  if (
    policy.allowedNetworks.length !== 1 ||
    policy.allowedNetworks[0] !== MELLO_NETWORK
  ) {
    context.addIssue({
      code: "custom",
      path: ["allowedNetworks"],
      message: "P0 only supports Base Sepolia",
    });
  }
  if (
    policy.allowedTokens.length !== 1 ||
    policy.allowedTokens[0]?.address.toLowerCase() !== BASE_SEPOLIA_USDC.toLowerCase()
  ) {
    context.addIssue({
      code: "custom",
      path: ["allowedTokens"],
      message: "P0 only supports Base Sepolia Test USDC",
    });
  }
});

const RUNNING_TASK_STATUSES = new Set([
  "PARSING",
  "DISCOVERING",
  "EVALUATING",
  "AUTH_ANCHOR_PENDING",
  "PAYING",
  "DELIVERING",
  "INVOICING",
  "RECONCILING",
  "FINAL_ANCHOR_PENDING",
]);

function requestId(response: Response): string {
  const value = response.locals["requestId"];
  return typeof value === "string" ? value : randomUUID();
}

function sendJson(response: Response, status: number, value: unknown): void {
  response.status(status).json(toJsonSafe(value));
}

function notFound(resource: string): never {
  throw new MelloError("NOT_FOUND", `${resource} not found`, { statusCode: 404 });
}

function tokensMatch(expected: string, supplied: string | undefined): boolean {
  if (!supplied) return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return (
    expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}

function demoAdmin(dependencies: CoreApiDependencies): RequestHandler {
  return (request, _response, next) => {
    if (
      tokensMatch(
        dependencies.config.DEMO_ADMIN_TOKEN,
        request.header("x-demo-admin-token"),
      )
    ) {
      next();
      return;
    }
    next(
      new MelloError("VALIDATION_ERROR", "A valid demo admin token is required", {
        statusCode: 401,
      }),
    );
  };
}

function databaseIsLocal(databaseUrl: string): boolean {
  try {
    const hostname = new URL(databaseUrl).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function backgroundConflict(message: string): never {
  throw new MelloError("TASK_ALREADY_RUNNING", message, { statusCode: 409 });
}

async function requireRetryState(
  dependencies: CoreApiDependencies,
  purchaseId: string,
): Promise<PurchaseRetryState> {
  const state = await dependencies.repository.getPurchaseRetryState(purchaseId);
  if (!state) return notFound("Purchase");
  return state;
}

async function enqueueInvoiceRetry(
  dependencies: CoreApiDependencies,
  state: PurchaseRetryState,
  operationRequestId: string,
): Promise<void> {
  if (!state.invoiceRetryable) {
    throw new MelloError("INVOICE_ISSUE_FAILED", "Invoice is not retryable", {
      statusCode: 409,
    });
  }
  await dependencies.workflowJobs.enqueue({
    kind: "RETRY_INVOICE",
    aggregateId: state.id,
    payload: {
      taskId: state.taskId,
      purchaseId: state.id,
      requestId: operationRequestId,
    },
    maxAttempts: dependencies.config.WORKFLOW_MAX_ATTEMPTS,
  });
}

async function enqueueAnchorRetry(
  dependencies: CoreApiDependencies,
  state: PurchaseRetryState,
  operationRequestId: string,
): Promise<void> {
  if (!state.anchorRetryable) {
    throw new MelloError("CONTRACT_ANCHOR_FAILED", "No retryable anchor exists", {
      statusCode: 409,
    });
  }
  if (!state.anchorPendingStatus) {
    throw new MelloError("CONTRACT_ANCHOR_FAILED", "Retryable anchor kind is unavailable", {
      statusCode: 409,
    });
  }
  await dependencies.workflowJobs.enqueue({
    kind: "RETRY_ANCHOR",
    aggregateId: state.id,
    payload: {
      taskId: state.taskId,
      purchaseId: state.id,
      requestId: operationRequestId,
    },
    maxAttempts: dependencies.config.WORKFLOW_MAX_ATTEMPTS,
  });
}

async function enqueuePaymentReconciliation(
  dependencies: CoreApiDependencies,
  state: PurchaseRetryState,
  operationRequestId: string,
): Promise<void> {
  if (!state.paymentReconciliationAvailable) {
    throw new MelloError("X402_PAYMENT_FAILED", "Payment has no pending settlement to reconcile", {
      statusCode: 409,
    });
  }
  await dependencies.workflowJobs.enqueue({
    kind: "RECONCILE_PAYMENT",
    aggregateId: state.id,
    payload: {
      taskId: state.taskId,
      purchaseId: state.id,
      requestId: operationRequestId,
    },
    maxAttempts: dependencies.config.WORKFLOW_MAX_ATTEMPTS,
  });
}

export function createApiRouter(dependencies: CoreApiDependencies): Router {
  const router = Router();
  const requireDemoAdmin = demoAdmin(dependencies);

  router.get("/registry", async (_request, response) => {
    if (!dependencies.registry) return notFound("Registry");
    sendJson(response, 200, { discoveryMode: dependencies.config.SERVICE_DISCOVERY_MODE, catalog: "cdp_bazaar", services: await dependencies.registry.list() });
  });
  router.get("/registry/discovery", async (_request, response) => {
    if (!dependencies.registry) return notFound("Registry");
    sendJson(response, 200, await dependencies.registry.discover());
  });
  router.post("/registry/services/:serviceId/verify", requireDemoAdmin, async (request, response) => {
    if (!dependencies.registry) return notFound("Registry");
    const { serviceId } = z.object({ serviceId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) }).parse(request.params);
    sendJson(response, 200, await dependencies.registry.verify(serviceId, VerifyServiceSchema.parse(request.body), requestId(response)));
  });
  router.put("/registry/services/:serviceId/binding", requireDemoAdmin, async (request, response) => {
    if (!dependencies.registry) return notFound("Registry");
    const { serviceId } = z.object({ serviceId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) }).parse(request.params);
    sendJson(response, 200, await dependencies.registry.updateBinding(serviceId, UpdateServiceBindingSchema.parse(request.body), requestId(response)));
  });
  router.post("/registry/services/:serviceId/revoke", requireDemoAdmin, async (request, response) => {
    if (!dependencies.registry) return notFound("Registry");
    const { serviceId } = z.object({ serviceId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) }).parse(request.params);
    const { reason } = z.object({ reason: z.string().trim().min(3).max(200) }).strict().parse(request.body);
    sendJson(response, 200, await dependencies.registry.revoke(serviceId, reason, requestId(response)));
  });

  router.get("/controls", async (_request, response) => {
    if (!dependencies.controls) return notFound("Procurement controls");
    sendJson(response, 200, await dependencies.controls.state());
  });
  router.put("/controls", requireDemoAdmin, async (request, response) => {
    if (!dependencies.controls) return notFound("Procurement controls");
    const { paymentsFrozen } = z.object({ paymentsFrozen: z.boolean() }).strict().parse(request.body);
    sendJson(response, 200, await dependencies.controls.setFrozen(paymentsFrozen));
  });
  router.post("/tasks/:taskId/approve", requireDemoAdmin, async (request, response) => {
    if (!dependencies.controls) return notFound("Procurement controls");
    const { taskId } = TaskIdentifierParamsSchema.parse(request.params);
    const operationRequestId = requestId(response);
    await dependencies.controls.approve(taskId, operationRequestId);
    await dependencies.workflowJobs.enqueue({ kind: "RUN_TASK", aggregateId: taskId,
      payload: { taskId, requestId: operationRequestId }, maxAttempts: dependencies.config.WORKFLOW_MAX_ATTEMPTS });
    sendJson(response, 202, { taskId, status: "PARSING" });
  });

  router.get("/demo/health", async (_request, response) => {
    sendJson(response, 200, await dependencies.healthService.check());
  });

  router.post("/demo/reset", requireDemoAdmin, async (_request, response) => {
    if (!databaseIsLocal(dependencies.config.DATABASE_URL)) {
      throw new MelloError(
        "VALIDATION_ERROR",
        "Demo reset is restricted to a local database",
        { statusCode: 403 },
      );
    }
    if (await dependencies.workflowJobs.hasActiveJobs()) {
      return backgroundConflict(
        "Demo reset is unavailable while workflow operations are queued or running",
      );
    }
    const result = await dependencies.repository.resetDemo();
    sendJson(response, 200, result);
  });

  router.get("/dashboard/summary", async (_request, response) => {
    const summary = await dependencies.repository.getDashboardSummary();
    sendJson(response, 200, {
      ...toObject(summary),
      modes: {
        agent: dependencies.config.AGENT_MODE,
        discovery: dependencies.config.SERVICE_DISCOVERY_MODE,
        payment: dependencies.config.PAYMENT_MODE,
        invoice: dependencies.config.INVOICE_PROVIDER,
        anchor: dependencies.config.CONTRACT_ANCHOR_MODE,
        offchainAuthorizationFallbackEnabled:
          dependencies.config.DEMO_ALLOW_OFFCHAIN_AUTH,
      },
    });
  });

  router.get("/settings", async (_request, response) => {
    const [company, policy, sellers, services] = await Promise.all([
      dependencies.repository.getCompany(),
      dependencies.repository.getActivePolicy(),
      dependencies.repository.listSellers(),
      dependencies.registry ? dependencies.registry.list() : dependencies.repository.listServices(),
    ]);
    sendJson(response, 200, { company, policy, sellers, services, discoveryMode: dependencies.config.SERVICE_DISCOVERY_MODE });
  });

  router.get("/company", async (_request, response) => {
    const company = await dependencies.repository.getCompany();
    if (!company) return notFound("Company profile");
    sendJson(response, 200, company);
  });

  router.put("/company", requireDemoAdmin, async (request, response) => {
    const input = CompanyProfileInputSchema.parse(request.body);
    sendJson(response, 200, await dependencies.repository.saveCompany(input));
  });

  router.get("/policies/active", async (_request, response) => {
    const policy = await dependencies.repository.getActivePolicy();
    if (!policy) return notFound("Active policy");
    sendJson(response, 200, policy);
  });

  router.put("/policies/active", requireDemoAdmin, async (request, response) => {
    const input = PolicyUpdateSchema.parse(request.body);
    sendJson(response, 200, await dependencies.repository.replaceActivePolicy(input));
  });

  router.get("/sellers", async (_request, response) => {
    sendJson(response, 200, { sellers: await dependencies.repository.listSellers() });
  });

  router.get("/services", async (request, response) => {
    const query = ServiceQuerySchema.parse(request.query);
    sendJson(response, 200, {
      services: await dependencies.repository.listServices(query.category),
    });
  });

  router.post("/tasks", async (request, response) => {
    const input = CreateTaskSchema.parse(request.body);
    if (dependencies.controls) {
      const task = await dependencies.controls.createTask(input);
      sendJson(response, task.deduplicated ? 200 : 201, { taskId: task.id, status: task.status,
        requestKey: task.requestKey, deduplicated: task.deduplicated });
      return;
    }
    const task = await dependencies.repository.createTask(input.prompt);
    sendJson(response, 201, { taskId: task.id, status: task.status });
  });

  router.get("/tasks", async (request, response) => {
    const pagination = PaginationSchema.parse(request.query);
    sendJson(response, 200, await dependencies.repository.listTasks(pagination));
  });

  router.post("/tasks/:taskId/discover", async (request, response) => {
    if (!dependencies.controls) return notFound("Procurement controls");
    const { taskId } = TaskIdentifierParamsSchema.parse(request.params);
    const operationRequestId = requestId(response);
    await dependencies.controls.discover(taskId, (transaction) => dependencies.workflowJobs.enqueue({
      kind: "RUN_TASK", aggregateId: taskId, payload: { taskId, requestId: operationRequestId },
      maxAttempts: dependencies.config.WORKFLOW_MAX_ATTEMPTS,
    }, transaction), operationRequestId);
    sendJson(response, 202, { taskId, status: "PARSING" });
  });

  router.post("/tasks/:taskId/select", async (request, response) => {
    if (!dependencies.controls) return notFound("Procurement controls");
    const { taskId } = TaskIdentifierParamsSchema.parse(request.params);
    const input = ServiceSelectionSchema.parse(request.body);
    const operationRequestId = requestId(response);
    const result = await dependencies.controls.selectService(taskId, input,
      (transaction) => dependencies.workflowJobs.enqueue({
        kind: "RUN_TASK", aggregateId: taskId, payload: { taskId, requestId: operationRequestId },
        maxAttempts: dependencies.config.WORKFLOW_MAX_ATTEMPTS,
      }, transaction), operationRequestId);
    sendJson(response, result.deduplicated ? 200 : 202, { taskId, ...result });
  });

  router.post("/tasks/:taskId/run", async (request, response) => {
    const { taskId } = TaskIdentifierParamsSchema.parse(request.params);
    const task = await dependencies.repository.getTaskExecutionState(taskId);
    if (!task) return notFound("Task");
    if (task.status === "COMPLETED" || task.status === "REJECTED") {
      sendJson(response, 200, await dependencies.repository.getTaskDetail(taskId));
      return;
    }
    if (RUNNING_TASK_STATUSES.has(task.status)) {
      throw new MelloError("TASK_ALREADY_RUNNING", "Task is already running", {
        statusCode: 409,
      });
    }
    if (task.status !== "CREATED") {
      throw new MelloError("TASK_ALREADY_RUNNING", "Use a dedicated retry endpoint", {
        statusCode: 409,
      });
    }
    const operationRequestId = requestId(response);
    await dependencies.controls?.ensureNotFrozen();
    await dependencies.workflowJobs.enqueue({
      kind: "RUN_TASK",
      aggregateId: taskId,
      payload: { taskId, requestId: operationRequestId },
      maxAttempts: dependencies.config.WORKFLOW_MAX_ATTEMPTS,
    });
    sendJson(response, 202, { taskId, status: "PARSING" });
  });

  router.get("/tasks/:taskId/events", async (request, response) => {
    const { taskId } = TaskIdentifierParamsSchema.parse(request.params);
    const task = await dependencies.repository.getTaskExecutionState(taskId);
    if (!task) return notFound("Task");
    const pagination = PaginationSchema.parse(request.query);
    const result = await dependencies.repository.listAuditEvents({
      ...pagination,
      taskId,
    });
    sendJson(response, 200, result.items);
  });

  router.post("/tasks/:taskId/retry-invoice", async (request, response) => {
    const { taskId } = TaskIdentifierParamsSchema.parse(request.params);
    const task = await dependencies.repository.getTaskExecutionState(taskId);
    if (!task) return notFound("Task");
    if (!task.purchaseId) {
      throw new MelloError("INVOICE_ISSUE_FAILED", "Task has no purchase", {
        statusCode: 409,
      });
    }
    const state = await requireRetryState(dependencies, task.purchaseId);
    const operationRequestId = requestId(response);
    await enqueueInvoiceRetry(dependencies, state, operationRequestId);
    sendJson(response, 202, { purchaseId: state.id, status: "INVOICING" });
  });

  router.post("/tasks/:taskId/retry-anchor", async (request, response) => {
    const { taskId } = TaskIdentifierParamsSchema.parse(request.params);
    const task = await dependencies.repository.getTaskExecutionState(taskId);
    if (!task) return notFound("Task");
    if (!task.purchaseId) {
      throw new MelloError("CONTRACT_ANCHOR_FAILED", "Task has no purchase", {
        statusCode: 409,
      });
    }
    const state = await requireRetryState(dependencies, task.purchaseId);
    const operationRequestId = requestId(response);
    await enqueueAnchorRetry(dependencies, state, operationRequestId);
    sendJson(response, 202, { purchaseId: state.id, status: state.anchorPendingStatus });
  });

  router.post(
    "/tasks/:taskId/reconcile-payment",
    requireDemoAdmin,
    async (request, response) => {
      const { taskId } = TaskIdentifierParamsSchema.parse(request.params);
      const task = await dependencies.repository.getTaskExecutionState(taskId);
      if (!task) return notFound("Task");
      if (!task.purchaseId) {
        throw new MelloError("X402_PAYMENT_FAILED", "Task has no purchase", {
          statusCode: 409,
        });
      }
      const state = await requireRetryState(dependencies, task.purchaseId);
      const operationRequestId = requestId(response);
      await enqueuePaymentReconciliation(dependencies, state, operationRequestId);
      sendJson(response, 202, { purchaseId: state.id, status: "PENDING_RECONCILIATION" });
    },
  );

  router.get("/tasks/:taskId", async (request, response) => {
    const { taskId } = TaskIdentifierParamsSchema.parse(request.params);
    const task = await dependencies.repository.getTaskDetail(taskId);
    if (!task) return notFound("Task");
    sendJson(response, 200, dependencies.controls
      ? { ...toObject(task), control: await dependencies.controls.detail(taskId) }
      : task);
  });

  router.get("/purchases", async (request, response) => {
    const pagination = PaginationSchema.parse(request.query);
    sendJson(response, 200, await dependencies.repository.listPurchases(pagination));
  });

  router.post("/purchases/:id/retry-invoice", async (request, response) => {
    const { id } = IdentifierParamsSchema.parse(request.params);
    const state = await requireRetryState(dependencies, id);
    const operationRequestId = requestId(response);
    await enqueueInvoiceRetry(dependencies, state, operationRequestId);
    sendJson(response, 202, { purchaseId: id, status: "INVOICING" });
  });

  router.post("/purchases/:id/retry-anchor", async (request, response) => {
    const { id } = IdentifierParamsSchema.parse(request.params);
    const state = await requireRetryState(dependencies, id);
    const operationRequestId = requestId(response);
    await enqueueAnchorRetry(dependencies, state, operationRequestId);
    sendJson(response, 202, { purchaseId: id, status: state.anchorPendingStatus });
  });

  router.post(
    "/purchases/:id/reconcile-payment",
    requireDemoAdmin,
    async (request, response) => {
      const { id } = IdentifierParamsSchema.parse(request.params);
      const state = await requireRetryState(dependencies, id);
      const operationRequestId = requestId(response);
      await enqueuePaymentReconciliation(dependencies, state, operationRequestId);
      sendJson(response, 202, { purchaseId: id, status: "PENDING_RECONCILIATION" });
    },
  );

  router.get("/purchases/:id/events", async (request, response) => {
    const { id } = IdentifierParamsSchema.parse(request.params);
    const purchase = await dependencies.repository.getPurchaseRetryState(id);
    if (!purchase) return notFound("Purchase");
    const pagination = PaginationSchema.parse(request.query);
    const result = await dependencies.repository.listAuditEvents({
      ...pagination,
      purchaseId: id,
    });
    sendJson(response, 200, result.items);
  });

  router.get("/purchases/:id", async (request, response) => {
    const { id } = IdentifierParamsSchema.parse(request.params);
    const purchase = await dependencies.repository.getPurchaseDetail(id);
    if (!purchase) return notFound("Purchase");
    sendJson(response, 200, purchase);
  });

  router.get("/audit-events", async (request, response) => {
    const filter = AuditEventQuerySchema.parse(request.query);
    sendJson(response, 200, await dependencies.repository.listAuditEvents(filter));
  });

  return router;
}

function toObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { summary: value };
}

export function createNotFoundHandler(): RequestHandler {
  return (request, _response, next) => {
    next(
      new MelloError("NOT_FOUND", `Route ${request.method} ${request.path} not found`, {
        statusCode: 404,
      }),
    );
  };
}

function isBodyParseError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "entity.parse.failed"
  );
}

function isPayloadTooLargeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (("type" in error && error.type === "entity.too.large") ||
      ("status" in error && error.status === 413))
  );
}

function isPrismaNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2025"
  );
}

export function createErrorHandler(
  dependencies: CoreApiDependencies,
): (error: unknown, request: Request, response: Response, next: NextFunction) => void {
  return (error, request, response, next) => {
    void next;
    const operationRequestId = requestId(response);
    if (error instanceof z.ZodError) {
      sendJson(response, 400, {
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          retryable: false,
          details: error.issues,
          requestId: operationRequestId,
        },
      });
      return;
    }
    if (isBodyParseError(error)) {
      sendJson(response, 400, {
        error: {
          code: "VALIDATION_ERROR",
          message: "Request body must contain valid JSON",
          retryable: false,
          requestId: operationRequestId,
        },
      });
      return;
    }
    if (isPayloadTooLargeError(error)) {
      sendJson(response, 413, {
        error: {
          code: "VALIDATION_ERROR",
          message: "Request body exceeds the 64 KB limit",
          retryable: false,
          requestId: operationRequestId,
        },
      });
      return;
    }
    const mappedError = isPrismaNotFoundError(error)
      ? new MelloError("NOT_FOUND", "Resource not found", { statusCode: 404 })
      : error;
    if (mappedError instanceof MelloError) {
      sendJson(response, mappedError.statusCode, {
        error: {
          code: mappedError.code,
          message: redactSensitiveText(mappedError.message),
          retryable: mappedError.retryable,
          details: redactSensitiveValue(mappedError.details),
          requestId: operationRequestId,
        },
      });
      return;
    }
    dependencies.logger.error(
      { err: error, requestId: operationRequestId, stage: "HTTP" },
      "Unhandled API error",
    );
    sendJson(response, 500, {
      error: {
        code: "INTERNAL_ERROR",
        message: "Unexpected server error",
        retryable: false,
        requestId: operationRequestId,
      },
    });
  };
}
