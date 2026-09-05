import type { Prisma, PrismaClient } from "@mello/db";
import {
  DEMO_COMPANY,
  DEMO_COMPANY_ID,
  DEMO_POLICY_ID,
  MELLO_NETWORK,
  MelloError,
  ServiceRecordSchema,
  getMarketService,
  redactSensitiveText,
  sanitizedErrorMessage,
  type CompanyProfileInput,
  type PolicyInput,
} from "@mello/shared";
import type { AppConfig } from "../config.js";
import type {
  AuditEventFilter,
  BackgroundFailureInput,
  CoreApiRepository,
  PaginatedResult,
  PaginationInput,
  PurchaseRetryState,
  TaskExecutionState,
} from "./contracts.js";
import { acquireWorkflowQueueExclusiveLock } from "../modules/workflow-jobs/queue-lock.js";

const PURCHASE_DETAIL_INCLUDE = {
  task: true,
  service: { include: { seller: true } },
  payment: true,
  authorization: true,
  delivery: true,
  invoice: true,
  reconciliation: true,
  anchors: { orderBy: { createdAt: "asc" as const } },
} satisfies Prisma.PurchaseInclude;

function countStatuses(records: readonly { status: string }[]): Record<string, number> {
  return records.reduce<Record<string, number>>((counts, record) => {
    counts[record.status] = (counts[record.status] ?? 0) + 1;
    return counts;
  }, {});
}

function errorCode(error: unknown): string {
  return error instanceof MelloError ? error.code : "INTERNAL_ERROR";
}

function errorMessage(error: unknown): string {
  return sanitizedErrorMessage(error, "Unexpected workflow error", 500);
}

function sanitizedStoredError(value: string | null): string | null {
  return value === null ? null : redactSensitiveText(value).slice(0, 2_000);
}

async function acquireBackgroundFailureLock(
  transaction: Prisma.TransactionClient,
  taskId: string,
): Promise<void> {
  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`mello:background-failure:${taskId}`}, 0)
    ) IS NULL AS "acquired"
  `;
}

function backgroundFailureStateConflict(input: {
  taskId: string;
  purchaseId?: string | undefined;
  expectedTaskStatus?: string | undefined;
  expectedPurchaseStatus?: string | undefined;
}): MelloError {
  return new MelloError(
    "INTERNAL_ERROR",
    "Workflow state changed while recording its final background failure",
    {
      statusCode: 409,
      retryable: true,
      details: input,
    },
  );
}

export function explorerLinksForPurchase(
  evidence: {
    paymentExplorerBase: string | null;
    anchorExplorerBase: string | null;
  },
): { payment: string | null; anchor: string | null } {
  return {
    payment: evidence.paymentExplorerBase,
    anchor: evidence.anchorExplorerBase,
  };
}

function catalogDisplay(service: { id: string; sellerId: string; category: string; displayName?: string | null }) {
  const market = getMarketService(service.id);
  // Only canonical new identities receive branding. Legacy purchase joins keep
  // their original service name and legal seller identity, including after archive.
  if (market && market.sellerId === service.sellerId && market.category === service.category) {
    return { displayName: market.displayName, sellerDisplayName: market.sellerDisplayName, description: market.description };
  }
  return service.displayName ? { displayName: service.displayName } : {};
}

export function normalizedService(
  service: {
    id: string;
    displayName?: string | null;
    sellerId: string;
    category: string;
    endpoint: string;
    method: string;
    priceAtomic: string;
    tokenSymbol: string;
    tokenAddress: string;
    tokenDecimals: number;
    network: string;
    supportsTwInvoice: boolean;
    active: boolean;
    seller: {
      legalName: string;
      businessId: string | null;
      payToAddress: string;
      invoiceCapability: string;
      invoiceProvider: string;
    };
  },
): unknown {
  return ServiceRecordSchema.parse({
    id: service.id,
    ...catalogDisplay(service),
    sellerId: service.sellerId,
    sellerLegalName: service.seller.legalName,
    sellerBusinessId: service.seller.businessId,
    payToAddress: service.seller.payToAddress,
    invoiceCapability: service.seller.invoiceCapability,
    invoiceProvider: service.seller.invoiceProvider,
    category: service.category,
    endpoint: service.endpoint,
    method: service.method,
    priceAtomic: service.priceAtomic,
    tokenSymbol: service.tokenSymbol,
    tokenAddress: service.tokenAddress,
    tokenDecimals: service.tokenDecimals,
    network: service.network,
    supportsTwInvoice: service.supportsTwInvoice,
    active: service.active,
  });
}

export function deliveryEvidenceForResponse<
  T extends { status: string; responseBody: unknown },
>(delivery: T | null): (Omit<T, "responseBody"> & { responseBody: unknown }) | null {
  if (!delivery) return null;
  return {
    ...delivery,
    // A receipt-timeout response is quarantined internally while the
    // delivery remains PENDING. Never expose it as paid output before
    // independent settlement verification succeeds.
    responseBody: delivery.status === "DELIVERED" ? delivery.responseBody : null,
  };
}

export class PrismaCoreApiRepository implements CoreApiRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: AppConfig,
  ) {}

  async getCompany(): Promise<unknown | null> {
    return this.prisma.companyProfile.findFirst({ orderBy: { createdAt: "asc" } });
  }

  async saveCompany(input: CompanyProfileInput): Promise<unknown> {
    // Older clients omit billing fields; do not overwrite their stored values.
    const data = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as {
      [Key in keyof CompanyProfileInput]: Exclude<CompanyProfileInput[Key], undefined>;
    };
    const existing = await this.prisma.companyProfile.findFirst({
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (existing) {
      return this.prisma.companyProfile.update({
        where: { id: existing.id },
        data,
      });
    }
    return this.prisma.companyProfile.create({
      data: { id: DEMO_COMPANY_ID, ...data },
    });
  }

  async getActivePolicy(): Promise<unknown | null> {
    return this.prisma.policy.findFirst({
      where: { active: true },
      orderBy: { version: "desc" },
    });
  }

  async replaceActivePolicy(input: PolicyInput): Promise<unknown> {
    return this.prisma.$transaction(async (transaction) => {
      const latest = await transaction.policy.findFirst({
        orderBy: { version: "desc" },
        select: { version: true },
      });
      await transaction.policy.updateMany({
        where: { active: true },
        data: { active: false },
      });
      return transaction.policy.create({
        data: {
          version: (latest?.version ?? 0) + 1,
          perTxLimitAtomic: input.perTxLimitAtomic,
          dailyLimitAtomic: input.dailyLimitAtomic,
          requireTwInvoice: input.requireTwInvoice,
          allowedNetworks: input.allowedNetworks,
          allowedTokens: input.allowedTokens,
          allowedSellerIds: input.allowedSellerIds,
          active: true,
        },
      });
    });
  }

  async listSellers(): Promise<unknown[]> {
    return this.prisma.seller.findMany({
      orderBy: { id: "asc" },
      include: { services: { orderBy: { id: "asc" } } },
    });
  }

  async listServices(category?: string): Promise<unknown[]> {
    const where: Prisma.ServiceWhereInput = { active: true, seller: { status: "ACTIVE" } };
    if (category) where.category = category;
    const services = await this.prisma.service.findMany({
      where,
      orderBy: { id: "asc" },
      include: { seller: true },
    });
    return services.map(normalizedService);
  }

  async createTask(prompt: string): Promise<{ id: string; status: "CREATED" }> {
    const task = await this.prisma.task.create({
      data: { prompt },
      select: { id: true },
    });
    return { id: task.id, status: "CREATED" };
  }

  async listTasks(pagination: PaginationInput): Promise<PaginatedResult> {
    const [items, total] = await Promise.all([
      this.prisma.task.findMany({
        orderBy: { createdAt: "desc" },
        take: pagination.limit,
        skip: pagination.offset,
        select: {
          id: true,
          prompt: true,
          status: true,
          decisionSummary: true,
          errorCode: true,
          errorMessage: true,
          usedFallbackParser: true,
          createdAt: true,
          updatedAt: true,
          completedAt: true,
          purchase: { select: { id: true } },
        },
      }),
      this.prisma.task.count(),
    ]);
    return {
      items: items.map(({ purchase, ...task }) => ({
        ...task,
        errorMessage: sanitizedStoredError(task.errorMessage),
        taskId: task.id,
        purchaseId: purchase?.id ?? null,
      })),
      total,
      ...pagination,
    };
  }

  async getTaskExecutionState(taskId: string): Promise<TaskExecutionState | null> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, status: true, purchase: { select: { id: true } } },
    });
    if (!task) return null;
    return {
      id: task.id,
      status: task.status,
      purchaseId: task.purchase?.id ?? null,
    };
  }

  async getTaskDetail(taskId: string): Promise<unknown | null> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: { purchase: { select: { id: true } } },
    });
    if (!task) return null;
    const [timeline, purchase] = await Promise.all([
      this.prisma.auditEvent.findMany({
        where: { taskId },
        orderBy: { sequence: "asc" },
      }),
      task.purchase ? this.getPurchaseDetail(task.purchase.id) : Promise.resolve(null),
    ]);
    return {
      taskId: task.id,
      status: task.status,
      prompt: task.prompt,
      intent: task.intent,
      candidates: task.candidates,
      decisionSummary: task.decisionSummary,
      usedFallbackParser: task.usedFallbackParser,
      error: task.errorCode
        ? { code: task.errorCode, message: sanitizedStoredError(task.errorMessage) }
        : null,
      runStartedAt: task.runStartedAt,
      completedAt: task.completedAt,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      purchaseId: task.purchase?.id ?? null,
      purchase,
      timeline,
    };
  }

  async listPurchases(pagination: PaginationInput): Promise<PaginatedResult> {
    const [purchases, total] = await Promise.all([
      this.prisma.purchase.findMany({
        orderBy: { createdAt: "desc" },
        take: pagination.limit,
        skip: pagination.offset,
        include: {
          task: { select: { prompt: true, status: true } },
          service: { include: { seller: true } },
          payment: { select: { status: true, transactionHash: true } },
          authorization: {
            select: {
              status: true,
              paymentId: true,
              nonce: true,
              validAfter: true,
              validBefore: true,
              typedDataHash: true,
              settlementTxHash: true,
            },
          },
          invoice: { select: { status: true, invoiceNumber: true } },
          reconciliation: { select: { status: true } },
          anchors: { select: { kind: true, status: true, transactionHash: true } },
        },
      }),
      this.prisma.purchase.count(),
    ]);
    return {
      items: purchases.map((purchase) => ({
        purchaseId: purchase.id,
        taskId: purchase.taskId,
        status: purchase.status,
        prompt: purchase.task.prompt,
        taskStatus: purchase.task.status,
        selectedService: {
          id: purchase.service.id,
          ...catalogDisplay(purchase.service),
          sellerId: purchase.service.sellerId,
          sellerLegalName: purchase.service.seller.legalName,
          priceAtomic: purchase.service.priceAtomic,
        },
        expectedAmountAtomic: purchase.expectedAmountAtomic,
        actualAmountAtomic: purchase.actualAmountAtomic,
        paymentMode: purchase.paymentMode,
        paymentAuthorizationHash: purchase.paymentAuthorizationHash,
        payment: purchase.payment,
        authorization: purchase.authorization
          ? {
              ...purchase.authorization,
              validAfter: purchase.authorization.validAfter.toString(),
              validBefore: purchase.authorization.validBefore.toString(),
            }
          : null,
        invoice: purchase.invoice,
        reconciliation: purchase.reconciliation,
        anchors: purchase.anchors,
        createdAt: purchase.createdAt,
        updatedAt: purchase.updatedAt,
      })),
      total,
      ...pagination,
    };
  }

  async getPurchaseDetail(purchaseId: string): Promise<unknown | null> {
    const purchase = await this.prisma.purchase.findUnique({
      where: { id: purchaseId },
      include: PURCHASE_DETAIL_INCLUDE,
    });
    if (!purchase) return null;
    const timeline = await this.prisma.auditEvent.findMany({
      where: { OR: [{ purchaseId }, { taskId: purchase.taskId }] },
      orderBy: { sequence: "asc" },
    });
    const policyDecision = timeline.find(
      (event) => event.eventType === "POLICY_APPROVED",
    )?.payload;
    const authorizationAnchorFallbackUsed = timeline.some(
      (event) => event.eventType === "AUTHORIZATION_ANCHOR_FALLBACK_USED",
    );
    const policyDecisionRecord =
      policyDecision !== null &&
      typeof policyDecision === "object" &&
      !Array.isArray(policyDecision)
        ? policyDecision
        : null;
    const offchainAuthorizationFallbackEnabled =
      policyDecisionRecord?.["offchainAuthorizationFallbackEnabled"] === true;
    const authorization = purchase.authorization
      ? {
          ...purchase.authorization,
          validAfter: purchase.authorization.validAfter.toString(),
          validBefore: purchase.authorization.validBefore.toString(),
          eip712ChainId: purchase.authorization.eip712ChainId.toString(),
        }
      : null;

    return {
      purchaseId: purchase.id,
      taskId: purchase.taskId,
      status: purchase.status,
      modes: {
        agent: purchase.agentMode,
        payment: purchase.paymentMode,
        invoice: purchase.invoiceMode,
        anchor: purchase.anchorMode,
        offchainAuthorizationFallbackEnabled,
      },
      explorerLinks: explorerLinksForPurchase(
        {
          paymentExplorerBase: purchase.paymentExplorerBase,
          anchorExplorerBase: purchase.anchorExplorerBase,
        },
      ),
      authorizationAnchorFallbackUsed,
      prompt: purchase.task.prompt,
      intent: purchase.task.intent,
      candidates: purchase.task.candidates,
      decisionSummary: purchase.task.decisionSummary,
      selectedService: normalizedService({
        ...purchase.service,
        seller: {
          ...purchase.service.seller,
          // Registry wallets can rotate; historical evidence must keep the
          // payee captured when this purchase was created.
          payToAddress: purchase.payToAddress,
        },
      }),
      discoveryEvidence: purchase.discoveryEvidence,
      policyDecision: policyDecision ?? null,
      policySnapshot: purchase.policySnapshot,
      mandateHash: purchase.mandateHash,
      policyHash: purchase.policyHash,
      paymentAuthorizationHash: purchase.paymentAuthorizationHash,
      expectedAmountAtomic: purchase.expectedAmountAtomic,
      actualAmountAtomic: purchase.actualAmountAtomic,
      network: purchase.network,
      token: {
        symbol: purchase.tokenSymbol,
        address: purchase.tokenAddress,
        decimals: purchase.tokenDecimals,
      },
      buyerAddress: purchase.buyerAddress,
      payToAddress: purchase.payToAddress,
      expiresAt: purchase.expiresAt,
      payment: purchase.payment,
      paymentAuthorization: authorization,
      delivery: deliveryEvidenceForResponse(purchase.delivery),
      invoice: purchase.invoice
        ? {
            ...purchase.invoice,
            buyerProfile: purchase.buyerProfileSnapshot,
            lastError: sanitizedStoredError(purchase.invoice.lastError),
          }
        : null,
      reconciliation: purchase.reconciliation,
      anchors: purchase.anchors.map((anchor) => ({
        ...anchor,
        errorMessage: sanitizedStoredError(anchor.errorMessage),
        blockNumber: anchor.blockNumber?.toString() ?? null,
      })),
      availableActions: {
        retryInvoice: purchase.invoice?.status === "FAILED_RETRYABLE",
        retryAnchor: purchase.anchors.some(
          (anchor) => anchor.status === "FAILED_RETRYABLE",
        ),
        reconcilePayment:
          purchase.payment?.status === "SETTLEMENT_PENDING" &&
          purchase.payment.transactionHash !== null,
      },
      timeline,
      createdAt: purchase.createdAt,
      updatedAt: purchase.updatedAt,
    };
  }

  async getPurchaseRetryState(purchaseId: string): Promise<PurchaseRetryState | null> {
    const purchase = await this.prisma.purchase.findUnique({
      where: { id: purchaseId },
      select: {
        id: true,
        taskId: true,
        invoice: { select: { status: true } },
        payment: { select: { status: true, transactionHash: true } },
        anchors: {
          orderBy: { createdAt: "asc" },
          select: { kind: true, status: true },
        },
      },
    });
    if (!purchase) return null;
    const failedAnchor = purchase.anchors.find(
      (anchor) => anchor.status === "FAILED_RETRYABLE",
    );
    return {
      id: purchase.id,
      taskId: purchase.taskId,
      invoiceRetryable: purchase.invoice?.status === "FAILED_RETRYABLE",
      anchorRetryable: failedAnchor !== undefined,
      anchorPendingStatus:
        failedAnchor?.kind === "AUTHORIZE"
          ? "AUTH_ANCHOR_PENDING"
          : failedAnchor?.kind === "FINALIZE"
            ? "FINAL_ANCHOR_PENDING"
            : failedAnchor?.kind === "FAIL"
              ? "FAILED"
              : null,
      paymentReconciliationAvailable:
        purchase.payment?.status === "SETTLEMENT_PENDING" &&
        purchase.payment.transactionHash !== null,
    };
  }

  async listAuditEvents(filter: AuditEventFilter): Promise<PaginatedResult> {
    const where: Prisma.AuditEventWhereInput = {};
    if (filter.aggregateType) where.aggregateType = filter.aggregateType;
    if (filter.aggregateId) where.aggregateId = filter.aggregateId;
    if (filter.taskId) where.taskId = filter.taskId;
    if (filter.purchaseId) where.purchaseId = filter.purchaseId;
    const [items, total] = await Promise.all([
      this.prisma.auditEvent.findMany({
        where,
        orderBy: { sequence: "asc" },
        take: filter.limit,
        skip: filter.offset,
      }),
      this.prisma.auditEvent.count({ where }),
    ]);
    return { items, total, limit: filter.limit, offset: filter.offset };
  }

  async getDashboardSummary(): Promise<unknown> {
    const [tasks, purchases, settledPayments, recentPurchases] = await Promise.all([
      this.prisma.task.findMany({ select: { status: true } }),
      this.prisma.purchase.findMany({ select: { status: true } }),
      this.prisma.payment.findMany({
        where: {
          status: "SETTLED",
          purchase: { paymentMode: this.config.PAYMENT_MODE },
        },
        select: { amountAtomic: true },
      }),
      this.listPurchases({ limit: 5, offset: 0 }),
    ]);
    const settledAmountAtomic = settledPayments
      .reduce((total, payment) => total + BigInt(payment.amountAtomic ?? "0"), 0n)
      .toString();
    return {
      counts: {
        tasks: tasks.length,
        purchases: purchases.length,
        completedPurchases: purchases.filter(({ status }) => status === "COMPLETED").length,
        actionRequired: purchases.filter(({ status }) => status === "ACTION_REQUIRED").length,
      },
      taskStatuses: countStatuses(tasks),
      purchaseStatuses: countStatuses(purchases),
      settledAmountAtomic,
      recentPurchases: recentPurchases.items,
      generatedAt: new Date().toISOString(),
    };
  }

  async resetDemo(): Promise<unknown> {
    const { config } = this;
    return this.prisma.$transaction(async (transaction) => {
      await acquireWorkflowQueueExclusiveLock(transaction);
      const activeJobs = await transaction.workflowJob.count({
        where: { status: { in: ["PENDING", "RUNNING", "FAILED_RETRYABLE"] } },
      });
      if (activeJobs > 0) {
        throw new MelloError(
          "TASK_ALREADY_RUNNING",
          "Demo reset is unavailable while workflow operations are queued or running",
          { statusCode: 409 },
        );
      }
      const [jobs, auditEvents, paymentCache] = await Promise.all([
        transaction.workflowJob.deleteMany(),
        transaction.auditEvent.deleteMany(),
        transaction.sellerPaymentCache.deleteMany(),
      ]);
      // Purchases reference both tasks and services. Delete them first so the
      // reset order stays deterministic even on databases that do not serialize
      // concurrent statements inside an interactive transaction.
      const purchases = await transaction.purchase.deleteMany();
      const tasks = await transaction.task.deleteMany();
      await transaction.service.deleteMany();
      await transaction.seller.deleteMany();
      await transaction.policy.deleteMany();
      await transaction.companyProfile.deleteMany();

      await transaction.companyProfile.create({ data: DEMO_COMPANY });
      await transaction.policy.create({
        data: {
          id: DEMO_POLICY_ID,
          version: 1,
          perTxLimitAtomic: "100000",
          dailyLimitAtomic: "1000000",
          requireTwInvoice: true,
          allowedNetworks: [MELLO_NETWORK],
          allowedTokens: [
            {
              symbol: "USDC",
              address: config.USDC_TOKEN_ADDRESS,
              decimals: config.USDC_TOKEN_DECIMALS,
            },
          ],
          allowedSellerIds: ["seller-a", "seller-b"],
          active: true,
        },
      });
      await transaction.seller.createMany({
        data: [
          {
            id: "seller-a",
            legalName: "Mello Data Labs A (Demo)",
            businessId: null,
            payToAddress: config.SELLER_A_PAY_TO,
            invoiceCapability: "NONE",
            invoiceProvider: "NONE",
            status: "ACTIVE",
          },
          {
            id: "seller-b",
            legalName: "Mello Data Labs B (Demo)",
            businessId: "24536806",
            payToAddress: config.SELLER_B_PAY_TO,
            invoiceCapability: "TW_B2B_DEMO",
            invoiceProvider: "MOCK",
            status: "ACTIVE",
          },
        ],
      });
      await transaction.service.createMany({
        data: [
          {
            id: "credit-report-a",
            sellerId: "seller-a",
            category: "credit_report",
            endpoint: `${config.SELLER_A_URL.replace(/\/$/, "")}/v1/credit-report`,
            method: "POST",
            priceAtomic: "40000",
            tokenSymbol: "USDC",
            tokenAddress: config.USDC_TOKEN_ADDRESS,
            tokenDecimals: config.USDC_TOKEN_DECIMALS,
            network: MELLO_NETWORK,
            supportsTwInvoice: false,
            active: true,
          },
          {
            id: "credit-report-b",
            sellerId: "seller-b",
            category: "credit_report",
            endpoint: `${config.SELLER_B_URL.replace(/\/$/, "")}/v1/credit-report`,
            method: "POST",
            priceAtomic: "50000",
            tokenSymbol: "USDC",
            tokenAddress: config.USDC_TOKEN_ADDRESS,
            tokenDecimals: config.USDC_TOKEN_DECIMALS,
            network: MELLO_NETWORK,
            supportsTwInvoice: true,
            active: true,
          },
        ],
      });
      const deleted = {
        workflowJobs: jobs.count,
        auditEvents: auditEvents.count,
        sellerPaymentCache: paymentCache.count,
        purchases: purchases.count,
        tasks: tasks.count,
      };
      const resetAt = new Date();
      await transaction.auditEvent.create({
        data: {
          aggregateType: "DEMO",
          aggregateId: "demo",
          eventType: "DEMO_RESET",
          actorType: "USER",
          payload: { schemaVersion: "1", deleted },
          stage: "RESET",
          createdAt: resetAt,
        },
      });
      return {
        status: "RESET",
        resetAt,
        deleted,
        seeded: {
          companyId: DEMO_COMPANY_ID,
          policyId: DEMO_POLICY_ID,
          sellers: ["seller-a", "seller-b"],
          services: ["credit-report-a", "credit-report-b"],
        },
      };
    });
  }

  async recordBackgroundFailure(input: BackgroundFailureInput): Promise<void> {
    const code = errorCode(input.error);
    const message = errorMessage(input.error);
    if (input.operation === "RUN_TASK" && input.taskId) {
      const taskId = input.taskId;
      await this.prisma.$transaction(async (transaction) => {
        await acquireBackgroundFailureLock(transaction, taskId);
        const eventType = "BACKGROUND_RUN_TASK_FAILED_FINAL";
        const existingEvent = await transaction.auditEvent.findFirst({
          where: {
            aggregateType: "TASK",
            aggregateId: taskId,
            eventType,
            requestId: input.requestId,
          },
          select: { id: true },
        });
        if (existingEvent) return;

        const task = await transaction.task.findUnique({
          where: { id: taskId },
          include: {
            purchase: {
              include: {
                payment: { select: { status: true } },
                authorization: { select: { status: true } },
              },
            },
          },
        });
        if (!task) return;
        const paymentMayHaveExecuted =
          task.purchase?.payment !== null &&
          task.purchase?.payment !== undefined &&
          !["NOT_STARTED", "FAILED"].includes(task.purchase.payment.status);
        const authorizationMayHaveExecuted =
          task.purchase?.authorization !== null &&
          task.purchase?.authorization !== undefined &&
          !["CREATED", "EXPIRED", "REJECTED"].includes(
            task.purchase.authorization.status,
          );
        const workflowWasInterrupted = ![
          "CREATED",
          "FAILED",
          "ACTION_REQUIRED",
        ].includes(task.status);
        const requiresManualReview =
          task.status === "ACTION_REQUIRED" ||
          workflowWasInterrupted ||
          paymentMayHaveExecuted ||
          authorizationMayHaveExecuted;

        if (!["COMPLETED", "REJECTED"].includes(task.status)) {
          const taskTransition = await transaction.task.updateMany({
            where: { id: taskId, status: task.status },
            data: {
              status: requiresManualReview ? "ACTION_REQUIRED" : "FAILED",
              errorCode: code,
              errorMessage: message,
            },
          });
          if (taskTransition.count !== 1) {
            throw backgroundFailureStateConflict({
              taskId,
              expectedTaskStatus: task.status,
            });
          }
        }
        if (
          task.purchase &&
          !["COMPLETED", "ACTION_REQUIRED"].includes(task.purchase.status)
        ) {
          const purchaseTransition = await transaction.purchase.updateMany({
            where: { id: task.purchase.id, status: task.purchase.status },
            data: { status: requiresManualReview ? "ACTION_REQUIRED" : "FAILED" },
          });
          if (purchaseTransition.count !== 1) {
            throw backgroundFailureStateConflict({
              taskId,
              purchaseId: task.purchase.id,
              expectedPurchaseStatus: task.purchase.status,
            });
          }
        }
        await transaction.auditEvent.create({
          data: {
            aggregateType: "TASK",
            aggregateId: taskId,
            eventType,
            actorType: "SYSTEM",
            payload: {
              errorCode: code,
              paymentMayHaveExecuted,
              authorizationMayHaveExecuted,
              workflowWasInterrupted,
              automaticRepaymentAllowed: false,
              terminalFailurePreserved: !requiresManualReview,
            },
            requestId: input.requestId,
            taskId,
            purchaseId: task.purchase?.id ?? null,
            stage: requiresManualReview ? "ACTION_REQUIRED" : "FAILED_FINAL",
          },
        });
      });
      return;
    }

    if (!input.purchaseId) return;
    const purchaseId = input.purchaseId;
    await this.prisma.$transaction(async (transaction) => {
      const identity = await transaction.purchase.findUnique({
        where: { id: purchaseId },
        select: { taskId: true },
      });
      if (!identity) return;
      await acquireBackgroundFailureLock(transaction, identity.taskId);

      const eventType = `BACKGROUND_${input.operation}_FAILED_FINAL`;
      const existingEvent = await transaction.auditEvent.findFirst({
        where: {
          aggregateType: "PURCHASE",
          aggregateId: purchaseId,
          eventType,
          requestId: input.requestId,
        },
        select: { id: true },
      });
      if (existingEvent) return;

      const purchase = await transaction.purchase.findUnique({
        where: { id: purchaseId },
        select: {
          id: true,
          taskId: true,
          status: true,
          task: { select: { status: true } },
        },
      });
      if (!purchase) return;
      const preserveTerminalFailure =
        purchase.status === "FAILED" && purchase.task.status === "FAILED";
      if (purchase.status !== "COMPLETED") {
        const purchaseTransition = await transaction.purchase.updateMany({
          where: { id: purchase.id, status: purchase.status },
          data: { status: preserveTerminalFailure ? "FAILED" : "ACTION_REQUIRED" },
        });
        if (purchaseTransition.count !== 1) {
          throw backgroundFailureStateConflict({
            taskId: purchase.taskId,
            purchaseId: purchase.id,
            expectedPurchaseStatus: purchase.status,
          });
        }
      }
      if (purchase.task.status !== "COMPLETED") {
        const taskTransition = await transaction.task.updateMany({
          where: { id: purchase.taskId, status: purchase.task.status },
          data: {
            status: preserveTerminalFailure ? "FAILED" : "ACTION_REQUIRED",
            errorCode: code,
            errorMessage: message,
          },
        });
        if (taskTransition.count !== 1) {
          throw backgroundFailureStateConflict({
            taskId: purchase.taskId,
            purchaseId: purchase.id,
            expectedTaskStatus: purchase.task.status,
          });
        }
      }
      await transaction.auditEvent.create({
        data: {
          aggregateType: "PURCHASE",
          aggregateId: purchase.id,
          eventType,
          actorType: "SYSTEM",
          payload: {
            errorCode: code,
            automaticRepaymentAllowed: false,
            terminalFailurePreserved: preserveTerminalFailure,
          },
          requestId: input.requestId,
          taskId: input.taskId ?? purchase.taskId,
          purchaseId: purchase.id,
          stage: preserveTerminalFailure ? "FAILED_FINAL" : "ACTION_REQUIRED",
        },
      });
    });
  }
}
