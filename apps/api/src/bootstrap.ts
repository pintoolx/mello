import {
  DisabledAuditAnchorClient,
  MockAuditAnchorClient,
  OnchainAuditAnchorClient,
  type AuditAnchorClient,
} from "@mello/contracts-client";
import { prisma as defaultPrisma, type PrismaClient } from "@mello/db";
import type { Logger } from "pino";
import type { Address, Hex } from "viem";
import { loadConfig, type AppConfig } from "./config.js";
import { DefaultHealthService } from "./http/default-health-service.js";
import type {
  CoreApiDependencies,
  HealthService,
} from "./http/contracts.js";
import { PrismaCoreApiRepository } from "./http/prisma-core-api-repository.js";
import { logger as defaultLogger } from "./logger.js";
import { ProcurementControls } from "./modules/controls/procurement-controls.js";
import { TaskAttachmentService } from "./modules/attachments/task-attachments.js";
import { CdpBazaarClient, type BazaarDiscovery } from "./modules/service-registry/bazaar-client.js";
import { ServiceRegistry } from "./modules/service-registry/registry-service.js";
import {
  MockInvoiceAdapter,
  type InvoiceAdapter,
} from "./modules/invoices/index.js";
import { ProcurementAgent } from "./modules/procurement-agent/index.js";
import { PurchaseWorkflow } from "./modules/purchases/index.js";
import {
  MockPaymentProvider,
  X402PaymentProvider,
  type PaymentProvider,
} from "./modules/x402-buyer/index.js";
import {
  PrismaWorkflowJobRepository,
  WorkflowJobWorker,
  type ClaimedWorkflowJob,
  type WorkflowJobPoller,
  type WorkflowJobStore,
} from "./modules/workflow-jobs/index.js";

export interface CoreApiBootstrapOverrides {
  bazaar?: BazaarDiscovery;
  config?: AppConfig | undefined;
  prisma?: PrismaClient | undefined;
  logger?: Logger | undefined;
  agent?: ProcurementAgent | undefined;
  paymentProvider?: PaymentProvider | undefined;
  invoiceAdapter?: InvoiceAdapter | undefined;
  anchorClient?: AuditAnchorClient | undefined;
  healthService?: HealthService | undefined;
  workflowJobStore?: WorkflowJobStore | undefined;
  workflowJobPoller?: WorkflowJobPoller | undefined;
}

async function workflowRetryIsSafe(
  prisma: PrismaClient,
  job: ClaimedWorkflowJob,
): Promise<boolean> {
  if (job.kind === "RUN_TASK" || job.kind === "DISCOVER_TASK") {
    const task = await prisma.task.findUnique({
      where: { id: job.aggregateId },
      select: { status: true },
    });
    // PurchaseWorkflow.run is intentionally not a resumable state machine. It
    // may only be re-entered before it has advanced the task beyond CREATED.
    return task?.status === "CREATED";
  }
  if (job.kind === "RETRY_INVOICE") {
    const invoice = await prisma.invoice.findUnique({
      where: { purchaseId: job.aggregateId },
      select: { status: true },
    });
    return invoice?.status === "FAILED_RETRYABLE";
  }
  if (job.kind === "RECONCILE_PAYMENT") {
    const payment = await prisma.payment.findUnique({
      where: { purchaseId: job.aggregateId },
      select: { status: true, transactionHash: true },
    });
    return payment?.status === "SETTLEMENT_PENDING" && payment.transactionHash !== null;
  }
  const retryableAnchor = await prisma.onchainAnchor.findFirst({
    where: { purchaseId: job.aggregateId, status: "FAILED_RETRYABLE" },
    select: { id: true },
  });
  return retryableAnchor !== null;
}

function createPaymentProvider(config: AppConfig): PaymentProvider {
  if (config.PAYMENT_MODE === "mock") return new MockPaymentProvider();
  if (!config.EVM_PRIVATE_KEY) {
    throw new Error("EVM_PRIVATE_KEY is required for the x402 payment provider");
  }
  return new X402PaymentProvider({
    privateKey: config.EVM_PRIVATE_KEY as Hex,
    rpcUrl: config.BASE_SEPOLIA_RPC_URL,
  });
}

function createInvoiceAdapter(config: AppConfig): InvoiceAdapter {
  if (config.INVOICE_PROVIDER === "mock") {
    return new MockInvoiceAdapter(config.MOCK_INVOICE_FAIL_ONCE);
  }
  throw new Error(
    "INVOICE_PROVIDER=ecpay_stage requires the optional EcpayStageAdapter",
  );
}

function createAnchorClient(config: AppConfig): AuditAnchorClient {
  if (config.CONTRACT_ANCHOR_MODE === "mock") return new MockAuditAnchorClient();
  if (config.CONTRACT_ANCHOR_MODE === "disabled") {
    return new DisabledAuditAnchorClient();
  }
  if (!config.CONTRACT_OPERATOR_PRIVATE_KEY || !config.AUDIT_REGISTRY_ADDRESS) {
    throw new Error(
      "On-chain anchoring requires CONTRACT_OPERATOR_PRIVATE_KEY and AUDIT_REGISTRY_ADDRESS",
    );
  }
  return new OnchainAuditAnchorClient({
    rpcUrl: config.BASE_SEPOLIA_RPC_URL,
    privateKey: config.CONTRACT_OPERATOR_PRIVATE_KEY as Hex,
    contractAddress: config.AUDIT_REGISTRY_ADDRESS as Address,
  });
}

export function createCoreApiDependencies(
  overrides: CoreApiBootstrapOverrides = {},
): CoreApiDependencies {
  const config = overrides.config ?? loadConfig();
  if (
    config.NODE_ENV === "production" &&
    config.DEMO_ADMIN_TOKEN === "change-me-before-public-deploy"
  ) {
    throw new Error("DEMO_ADMIN_TOKEN must be changed before a production deployment");
  }
  const prisma = overrides.prisma ?? defaultPrisma;
  const logger = overrides.logger ?? defaultLogger;
  const agent =
    overrides.agent ??
    new ProcurementAgent({
      mode: config.AGENT_MODE,
      timeoutMs: 20_000,
      ...(config.OPENAI_API_KEY ? { apiKey: config.OPENAI_API_KEY } : {}),
      ...(config.OPENAI_MODEL ? { model: config.OPENAI_MODEL } : {}),
    });
  const paymentProvider = overrides.paymentProvider ?? createPaymentProvider(config);
  const invoiceAdapter = overrides.invoiceAdapter ?? createInvoiceAdapter(config);
  const anchorClient = overrides.anchorClient ?? createAnchorClient(config);
  const controls = new ProcurementControls(prisma);
  const registry = new ServiceRegistry(prisma, overrides.bazaar ?? new CdpBazaarClient({ timeoutMs: config.BAZAAR_TIMEOUT_MS }));
  const workflow = new PurchaseWorkflow({
    registry,
    controls,
    prisma,
    config,
    agent,
    paymentProvider,
    invoiceAdapter,
    anchorClient,
    logger,
  });
  const healthService =
    overrides.healthService ??
    new DefaultHealthService({
      prisma,
      config,
      paymentProvider,
      anchorClient,
    });
  const repository = new PrismaCoreApiRepository(prisma, config);
  const workflowJobStore =
    overrides.workflowJobStore ?? new PrismaWorkflowJobRepository(prisma);
  const workflowJobPoller =
    overrides.workflowJobPoller ??
    new WorkflowJobWorker(
      {
        store: workflowJobStore,
        workflow,
        logger,
        recordFinalFailure: (input) => repository.recordBackgroundFailure(input),
      },
      {
        pollIntervalMs: config.WORKFLOW_POLL_INTERVAL_MS,
        leaseMs: config.WORKFLOW_LEASE_MS,
        backoffBaseMs: config.WORKFLOW_BACKOFF_BASE_MS,
        isRetrySafe: (job) => workflowRetryIsSafe(prisma, job),
      },
    );

  return {
    attachments: new TaskAttachmentService(prisma),
    registry,
    controls,
    config,
    repository,
    workflow,
    healthService,
    logger,
    workflowJobs: workflowJobStore,
    workflowJobPoller,
  };
}
