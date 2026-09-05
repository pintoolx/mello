import { randomUUID } from "node:crypto";
import type { ProcurementControls } from "../controls/procurement-controls.js";
import { CdpBazaarClient } from "../service-registry/bazaar-client.js";
import { ServiceRegistry } from "../service-registry/registry-service.js";
import {
  AnchorSubmissionPersistenceError,
  AnchorTransactionRevertedError,
  type AuditAnchorClient,
  type AnchorTransactionResult,
} from "@mello/contracts-client";
import { Prisma, type PrismaClient } from "@mello/db";
import {
  MelloError,
  MELLO_CHAIN_ID,
  PolicyInputSchema,
  InvoiceBuyerProfileSchema,
  invoiceBuyerProfile,
  PurchaseIntentSchema,
  TaskRequirementsSchema,
  ServiceSelectionSchema,
  ServiceRecordSchema,
  hashCanonicalJson,
  sanitizedErrorMessage,
  type CompanyProfileInput,
  type PolicyInput,
} from "@mello/shared";
import { generatePaymentId } from "@x402/extensions/payment-identifier";
import type { AppConfig } from "../../config.js";
import type { Logger } from "pino";
import { createPurchaseContextToken } from "../../security/purchase-context.js";
import {
  anchorExplorerBaseForVerifiedConfirmation,
  capturePurchaseRuntimeEvidence,
  paymentExplorerBaseForVerifiedSettlement,
} from "../../runtime-evidence.js";
import { appendAuditEvent, jsonValue } from "../audit/index.js";
import type { InvoiceAdapter } from "../invoices/index.js";
import {
  RetryableInvoiceError,
  issueInvoiceSafely,
  notRequiredInvoiceEvidenceHash,
} from "../invoices/index.js";
import type { ProcurementAgent } from "../procurement-agent/agent.js";
import {
  evaluateCandidates,
  selectCandidate,
} from "../procurement-agent/candidate-evaluator.js";
import { evaluatePolicy } from "../policies/index.js";
import { surveyCandidate } from "../procurement-agent/survey.js";
import { reconcilePurchase } from "../reconciliation/index.js";
import {
  PendingSettlementVerificationError,
  PaymentSettlementReportSchema,
  SettledPaymentDeliveryError,
  maximumAuthorizationValidBefore,
  type PaymentProvider,
  type PendingSettlementEvidence,
  type PaymentSettlement,
  type PreparedPayment,
} from "../x402-buyer/index.js";
import { withDailySpendReservationLock } from "./daily-spend-reservation.js";
import { claimAnchorRetry, claimInvoiceRetry } from "./retry-claim.js";
import { withAuthorizationNonceReservation } from "./authorization-nonce-ledger.js";
import {
  beginAnchorAttempt,
  confirmAnchorState,
  persistIssuedInvoice,
  startTaskRun,
  transitionPurchaseWorkflowStage,
} from "./workflow-state-transitions.js";

const MIN_RETRY_CLAIM_LEASE_MS = 10 * 60_000;

export interface PurchaseWorkflowDependencies {
  registry?: ServiceRegistry;
  controls?: ProcurementControls;
  prisma: PrismaClient;
  config: AppConfig;
  agent: ProcurementAgent;
  paymentProvider: PaymentProvider;
  invoiceAdapter: InvoiceAdapter;
  anchorClient: AuditAnchorClient;
  logger: Logger;
  now?: () => Date;
  invoiceTimeoutMs?: number;
}

interface ActivePolicy extends PolicyInput {
  id: string;
  version: number;
}

interface AuthorizationAnchorInput {
  id: string;
  buyerAddress: string;
  payToAddress: string;
  tokenAddress: string;
  maxAmountAtomic: string;
  expiresAt: Date;
  mandateHash: string;
  policyHash: string;
  paymentAuthorizationHash: string;
}

interface FinalizationAnchorInput {
  id: string;
  actualAmountAtomic: string;
  settlementTxHash: string;
  receiptHash: string;
  invoiceHash: string;
  reconciliationHash: string;
}

interface FailureAnchorInput {
  id: string;
  errorCode: string;
}

const RUNNING_TASK_STATUSES = [
  "PARSING",
  "DISCOVERING",
  "EVALUATING",
  "AUTH_ANCHOR_PENDING",
  "PAYING",
  "DELIVERING",
  "INVOICING",
  "RECONCILING",
  "FINAL_ANCHOR_PENDING",
] as const;

export class PurchaseWorkflow {
  private readonly registry: ServiceRegistry;
  private readonly now: () => Date;
  private readonly invoiceTimeoutMs: number;

  constructor(private readonly dependencies: PurchaseWorkflowDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.registry = dependencies.registry ?? new ServiceRegistry(dependencies.prisma, new CdpBazaarClient({ timeoutMs: dependencies.config.BAZAAR_TIMEOUT_MS }), this.now);
    this.invoiceTimeoutMs = dependencies.invoiceTimeoutMs ?? 10_000;
  }

  async run(taskId: string, requestId?: string): Promise<void> {
    const { prisma, logger } = this.dependencies;
    const existing = await prisma.task.findUnique({
      where: { id: taskId },
      include: { purchase: true },
    });
    if (!existing) throw new MelloError("NOT_FOUND", "Task not found", { statusCode: 404 });
    if (existing.status === "COMPLETED" || existing.status === "REJECTED") return;
    if ((RUNNING_TASK_STATUSES as readonly string[]).includes(existing.status)) {
      throw new MelloError("TASK_ALREADY_RUNNING", "Task is already running", {
        statusCode: 409,
      });
    }
    if (existing.status !== "CREATED") {
      throw new MelloError("TASK_ALREADY_RUNNING", "Use a dedicated retry endpoint", {
        statusCode: 409,
      });
    }

    await startTaskRun(prisma, { taskId, startedAt: this.now(), requestId });

    try {
      await this.execute(taskId, requestId);
    } catch (error: unknown) {
      logger.error(
        { err: error, taskId, requestId, stage: "WORKFLOW" },
        "Purchase workflow failed",
      );
      await this.failTask(taskId, error, requestId);
      throw error;
    }
  }

  async retryInvoice(purchaseId: string, requestId?: string): Promise<void> {
    const claimId = randomUUID();
    const purchase = await this.dependencies.prisma.$transaction(async (transaction) => {
      const candidate = await transaction.purchase.findUnique({
        where: { id: purchaseId },
        include: { invoice: true, payment: true, delivery: true },
      });
      if (!candidate) {
        throw new MelloError("NOT_FOUND", "Purchase not found", { statusCode: 404 });
      }
      if (candidate.invoice?.status !== "FAILED_RETRYABLE") {
        throw new MelloError("INVOICE_ISSUE_FAILED", "Invoice is not retryable", {
          statusCode: 409,
        });
      }
      if (candidate.payment?.status !== "SETTLED" || candidate.delivery?.status !== "DELIVERED") {
        throw new MelloError("INVOICE_ISSUE_FAILED", "Payment and delivery must remain complete", {
          statusCode: 409,
        });
      }
      const claimed = await claimInvoiceRetry(transaction, candidate.invoice.id, {
        claimId,
        claimedAt: this.now(),
        staleBefore: this.retryClaimCutoff(),
      });
      if (!claimed) {
        throw new MelloError("INVOICE_ISSUE_FAILED", "Invoice retry is already running", {
          statusCode: 409,
        });
      }
      await transitionPurchaseWorkflowStage(transaction, {
        taskId: candidate.taskId,
        purchaseId,
        expectedTaskStatuses: ["ACTION_REQUIRED"],
        expectedPurchaseStatuses: ["ACTION_REQUIRED"],
        nextTaskStatus: "INVOICING",
        nextPurchaseStatus: "INVOICING",
        taskData: { errorCode: null, errorMessage: null },
        aggregateType: "INVOICE",
        aggregateId: candidate.invoice.id,
        paymentId: candidate.paymentId,
        requestId,
        stage: "INVOICING",
        actorType: "USER",
        eventType: "INVOICE_RETRY_REQUESTED",
        payload: { previousAttempts: candidate.invoice.attemptCount, claimId },
      });
      return candidate;
    });
    try {
      await this.issueInvoiceAndComplete(purchaseId, requestId);
    } finally {
      await this.dependencies.prisma.invoice.updateMany({
        where: { id: purchase.invoice!.id, retryClaimId: claimId },
        data: { retryClaimId: null, retryClaimedAt: null },
      });
    }
  }

  async reconcilePayment(purchaseId: string, requestId?: string): Promise<void> {
    const { paymentProvider, prisma } = this.dependencies;
    const purchase = await prisma.purchase.findUnique({
      where: { id: purchaseId },
      include: {
        task: true,
        buyerProfile: true,
        service: { include: { seller: true } },
        payment: true,
        authorization: true,
        reconciliation: true,
        delivery: true,
        invoice: true,
      },
    });
    if (!purchase) {
      throw new MelloError("NOT_FOUND", "Purchase not found", { statusCode: 404 });
    }
    if (purchase.reconciliation?.status === "MISMATCH") {
      throw new MelloError(
        "RECONCILIATION_MISMATCH",
        "Existing reconciliation mismatch requires operator investigation",
        { statusCode: 409 },
      );
    }
    if (
      purchase.payment?.status === "SETTLED" &&
      purchase.authorization?.status === "SETTLED" &&
      purchase.payment.transactionHash !== null &&
      purchase.payment.transactionHash === purchase.authorization.settlementTxHash
    ) {
      if (
        purchase.delivery?.status === "DELIVERED" &&
        purchase.status !== "COMPLETED"
      ) {
        if (
          (purchase.task.status === "DELIVERING" && purchase.status === "DELIVERED") ||
          (purchase.task.status === "ACTION_REQUIRED" && purchase.status === "ACTION_REQUIRED")
        ) {
          await this.startInvoicing({
            taskId: purchase.taskId,
            purchaseId,
            paymentId: purchase.paymentId,
            sellerId: purchase.service.sellerId,
            requestId,
            transactionHash: purchase.payment.transactionHash,
          });
          await this.issueInvoiceAndComplete(purchaseId, requestId);
        } else if (
          (purchase.task.status === "INVOICING" && purchase.status === "INVOICING") ||
          (purchase.task.status === "RECONCILING" && purchase.status === "RECONCILING")
        ) {
          await this.issueInvoiceAndComplete(purchaseId, requestId);
        }
      }
      return;
    }
    if (
      purchase.payment?.status !== "SETTLEMENT_PENDING" ||
      !purchase.payment.transactionHash ||
      !purchase.payment.paymentResponse ||
      !purchase.payment.payerAddress ||
      !purchase.payment.payeeAddress ||
      !purchase.payment.amountAtomic ||
      !purchase.payment.network ||
      !purchase.payment.tokenAddress ||
      !purchase.authorization
    ) {
      throw new MelloError(
        "X402_PAYMENT_FAILED",
        "Purchase has no complete pending settlement candidate to reconcile",
        { statusCode: 409 },
      );
    }
    if (!paymentProvider.verifySettlement) {
      throw new MelloError(
        "X402_PAYMENT_FAILED",
        "The configured payment provider cannot independently verify settlement receipts",
        { statusCode: 409 },
      );
    }

    const financialReconciliation = reconcilePurchase({
      scope: "SETTLEMENT",
      service: {
        amountAtomic: purchase.service.priceAtomic,
        payee: purchase.service.seller.payToAddress,
        network: purchase.service.network,
        token: {
          symbol: purchase.service.tokenSymbol,
          address: purchase.service.tokenAddress,
          decimals: purchase.service.tokenDecimals,
        },
        sellerProfileId: purchase.service.sellerId,
        sellerBusinessId: purchase.service.seller.businessId,
      },
      purchase: {
        expectedAmountAtomic: purchase.expectedAmountAtomic,
        actualAmountAtomic: purchase.actualAmountAtomic,
        payee: purchase.payToAddress,
        payer: purchase.buyerAddress,
        network: purchase.network,
        token: {
          symbol: purchase.tokenSymbol,
          address: purchase.tokenAddress,
          decimals: purchase.tokenDecimals,
        },
        paymentId: purchase.paymentId,
      },
      authorization: {
        paymentId: purchase.authorization.paymentId,
        amountAtomic: purchase.authorization.amountAtomic,
        payee: purchase.authorization.toAddress,
        payer: purchase.authorization.fromAddress,
        network: purchase.authorization.network,
        tokenAddress: purchase.authorization.tokenAddress,
        status: purchase.authorization.status,
        settlementTransactionHash: purchase.authorization.settlementTxHash,
      },
      payment: {
        paymentId: purchase.payment.paymentId,
        status: purchase.payment.status,
        transactionHash: purchase.payment.transactionHash,
        amountAtomic: purchase.payment.amountAtomic,
        payee: purchase.payment.payeeAddress,
        payer: purchase.payment.payerAddress,
        network: purchase.payment.network,
        tokenAddress: purchase.payment.tokenAddress,
      },
      invoiceRequired: false,
      invoice: null,
      companyBusinessId: purchase.buyerProfile.businessId,
      deliveryResponseHash: null,
    });
    if (financialReconciliation.status !== "MATCHED") {
      await prisma.$transaction(async (transaction) => {
        const reconciliationTransition = await transaction.reconciliation.updateMany({
          where: { purchaseId, status: "PENDING" },
          data: {
            status: "MISMATCH",
            checks: jsonValue(financialReconciliation.checks),
            canonicalHash: financialReconciliation.canonicalHash,
            reconciledAt: null,
          },
        });
        if (reconciliationTransition.count !== 1) {
          throw new MelloError(
            "RECONCILIATION_MISMATCH",
            "Reconciliation state changed before mismatch evidence was committed",
            { statusCode: 409 },
          );
        }
        await transitionPurchaseWorkflowStage(transaction, {
          taskId: purchase.taskId,
          purchaseId,
          expectedTaskStatuses: ["ACTION_REQUIRED"],
          expectedPurchaseStatuses: ["ACTION_REQUIRED"],
          nextTaskStatus: "ACTION_REQUIRED",
          nextPurchaseStatus: "ACTION_REQUIRED",
          taskData: {
            errorCode: "RECONCILIATION_MISMATCH",
            errorMessage: "Pending settlement evidence does not match approved payment terms",
          },
          aggregateType: "PAYMENT",
          aggregateId: purchase.paymentId,
          paymentId: purchase.paymentId,
          sellerId: purchase.service.sellerId,
          requestId,
          stage: "RECONCILING",
          eventType: "PAYMENT_RECONCILIATION_MISMATCH",
          payload: financialReconciliation,
        });
      });
      return;
    }

    const candidateTransactionHash = purchase.payment.transactionHash as `0x${string}`;
    const parsedQuarantinedReport = PaymentSettlementReportSchema.safeParse(
      purchase.delivery?.status === "PENDING" ? purchase.delivery.responseBody : null,
    );
    const intent = purchase.task.intent as { targetCompanyName?: string } | null;
    const quarantinedReport =
      parsedQuarantinedReport.success &&
      parsedQuarantinedReport.data.provider === purchase.service.sellerId &&
      parsedQuarantinedReport.data.targetCompanyName === intent?.targetCompanyName
        ? parsedQuarantinedReport.data
        : null;
    const evidence: PendingSettlementEvidence = {
      paymentId: purchase.paymentId,
      transactionHash: candidateTransactionHash,
      payerAddress: purchase.authorization.fromAddress as `0x${string}`,
      payeeAddress: purchase.authorization.toAddress as `0x${string}`,
      amountAtomic: purchase.authorization.amountAtomic,
      network: purchase.authorization.network,
      tokenAddress: purchase.authorization.tokenAddress as `0x${string}`,
      paymentResponse: purchase.payment.paymentResponse,
      ...(quarantinedReport ? { report: quarantinedReport } : {}),
    };
    const verification = await paymentProvider.verifySettlement(evidence);
    const verifiedEvidence = {
      ...evidence,
      verifiedChainId: verification.verifiedChainId,
    };

    const advanced = await prisma.$transaction(async (transaction) => {
      const currentReconciliation = await transaction.reconciliation.findUnique({
        where: { purchaseId },
        select: { status: true },
      });
      if (currentReconciliation?.status === "MISMATCH") {
        throw new MelloError(
          "RECONCILIATION_MISMATCH",
          "Reconciliation changed to mismatch while the receipt was being verified",
          { statusCode: 409 },
        );
      }
      const claimed = await transaction.payment.updateMany({
        where: {
          purchaseId,
          status: "SETTLEMENT_PENDING",
          transactionHash: candidateTransactionHash,
        },
        data: { status: "SETTLED", settledAt: this.now() },
      });
      if (claimed.count !== 1) {
        const current = await transaction.payment.findUnique({
          where: { purchaseId },
          select: { status: true, transactionHash: true },
        });
        if (current?.status === "SETTLED" && current.transactionHash === candidateTransactionHash) {
          return false;
        }
        throw new MelloError(
          "X402_PAYMENT_FAILED",
          "Pending settlement changed while its receipt was being verified",
          { statusCode: 409 },
        );
      }
      const authorizationUpdated = await transaction.paymentAuthorization.updateMany({
        where: {
          purchaseId,
          paymentId: purchase.paymentId,
          status: "SUBMITTED",
        },
        data: { status: "SETTLED", settlementTxHash: candidateTransactionHash },
      });
      if (authorizationUpdated.count !== 1) {
        throw new MelloError(
          "RECONCILIATION_MISMATCH",
          "Authorization state changed while settlement was being reconciled",
          { statusCode: 409 },
        );
      }
      const pendingHash = hashCanonicalJson({
        schemaVersion: "1",
        kind: "PAYMENT_RECEIPT_RECOVERY",
        status: "PENDING",
        transactionHash: candidateTransactionHash,
        receiptIndependentlyVerified: true,
        checks: financialReconciliation.checks,
      });
      const reconciliationUpdated = await transaction.reconciliation.updateMany({
        where: { purchaseId, status: "PENDING" },
        data: {
          status: "PENDING",
          checks: jsonValue(financialReconciliation.checks),
          canonicalHash: pendingHash,
          reconciledAt: null,
        },
      });
      const deliveryUpdated = await transaction.delivery.updateMany({
        where: { purchaseId, status: "PENDING" },
        data: quarantinedReport
          ? {
              status: "DELIVERED",
              responseBody: jsonValue(quarantinedReport),
              responseHash: hashCanonicalJson({
                schemaVersion: "1",
                report: quarantinedReport,
              }),
              deliveredAt: this.now(),
            }
          : { status: "FAILED" },
      });
      if (reconciliationUpdated.count !== 1 || deliveryUpdated.count !== 1) {
        throw new MelloError("INTERNAL_ERROR", "Recovery evidence changed before commit", {
          statusCode: 409,
          retryable: true,
        });
      }
      await this.appendVerifiedFacilitatorLifecycle(transaction, {
        taskId: purchase.taskId,
        purchaseId,
        paymentId: purchase.paymentId,
        sellerId: purchase.service.sellerId,
        requestId,
        transactionHash: candidateTransactionHash,
        verifiedChainId: verification.verifiedChainId,
        recovered: true,
      });
      await transitionPurchaseWorkflowStage(transaction, {
        taskId: purchase.taskId,
        purchaseId,
        expectedTaskStatuses: ["ACTION_REQUIRED"],
        expectedPurchaseStatuses: ["ACTION_REQUIRED"],
        nextTaskStatus: quarantinedReport ? "DELIVERING" : "ACTION_REQUIRED",
        nextPurchaseStatus: quarantinedReport ? "DELIVERED" : "ACTION_REQUIRED",
        taskData: {
          errorCode: quarantinedReport ? null : "SERVICE_DELIVERY_FAILED",
          errorMessage: quarantinedReport
            ? null
            : "Settlement receipt was independently verified; paid resource delivery requires operator recovery",
        },
        purchaseData: {
          actualAmountAtomic: purchase.payment!.amountAtomic,
          paymentExplorerBase: paymentExplorerBaseForVerifiedSettlement(
            this.dependencies.config,
            verifiedEvidence,
          ),
        },
        aggregateType: "PAYMENT",
        aggregateId: purchase.paymentId,
        paymentId: purchase.paymentId,
        sellerId: purchase.service.sellerId,
        requestId,
        stage: quarantinedReport ? "DELIVERING" : "PENDING_RECONCILIATION",
        actorType: "USER",
        eventType: "PAYMENT_SETTLEMENT_RECONCILED",
        payload: {
          transactionHash: candidateTransactionHash,
          verifiedChainId: verification.verifiedChainId,
          receiptIndependentlyVerified: true,
          paymentStatus: "SETTLED",
          authorizationStatus: "SETTLED",
          deliveryStatus: quarantinedReport ? "DELIVERED" : "FAILED",
          quarantinedReportPromoted: quarantinedReport !== null,
          automaticRepaymentAllowed: false,
          financialReconciliation,
        },
      });
      return true;
    });
    if (advanced && quarantinedReport) {
      await this.startInvoicing({
        taskId: purchase.taskId,
        purchaseId,
        paymentId: purchase.paymentId,
        sellerId: purchase.service.sellerId,
        requestId,
        transactionHash: candidateTransactionHash,
      });
      await this.issueInvoiceAndComplete(purchaseId, requestId);
    }
  }

  async retryAnchor(purchaseId: string, requestId?: string): Promise<void> {
    const claimId = randomUUID();
    const { purchase, failed } = await this.dependencies.prisma.$transaction(
      async (transaction) => {
        const candidate = await transaction.purchase.findUnique({
          where: { id: purchaseId },
          include: {
            anchors: { orderBy: { createdAt: "asc" } },
            task: true,
            service: true,
            payment: true,
            authorization: true,
            delivery: true,
            invoice: true,
            reconciliation: true,
          },
        });
        if (!candidate) {
          throw new MelloError("NOT_FOUND", "Purchase not found", { statusCode: 404 });
        }
        const retryable = candidate.anchors.find(
          (anchor) => anchor.status === "FAILED_RETRYABLE",
        );
        if (!retryable) {
          throw new MelloError("CONTRACT_ANCHOR_FAILED", "No retryable anchor exists", {
            statusCode: 409,
          });
        }
        if (retryable.kind === "AUTHORIZE" && !candidate.paymentAuthorizationHash) {
          throw new MelloError("CONTRACT_ANCHOR_FAILED", "Authorization evidence is missing", {
            statusCode: 409,
          });
        }
        if (
          retryable.kind === "FINALIZE" &&
          (!candidate.payment?.transactionHash ||
            !candidate.delivery?.responseHash ||
            !candidate.invoice?.canonicalHash ||
            !candidate.reconciliation?.canonicalHash)
        ) {
          throw new MelloError("CONTRACT_ANCHOR_FAILED", "Anchor evidence is incomplete", {
            statusCode: 409,
          });
        }
        const claimed = await claimAnchorRetry(transaction, retryable.id, {
          claimId,
          claimedAt: this.now(),
          staleBefore: this.retryClaimCutoff(),
        });
        if (!claimed) {
          throw new MelloError("CONTRACT_ANCHOR_FAILED", "Anchor retry is already running", {
            statusCode: 409,
          });
        }
        return { purchase: candidate, failed: retryable };
      },
    );

    try {
      if (failed.kind === "AUTHORIZE") {
      const intent = purchase.task.intent as { maxAmount?: { atomic?: string } } | null;
      const anchorInput: AuthorizationAnchorInput = {
        id: purchase.id,
        buyerAddress: purchase.buyerAddress,
        payToAddress: purchase.payToAddress,
        tokenAddress: purchase.tokenAddress,
        maxAmountAtomic: intent?.maxAmount?.atomic ?? purchase.expectedAmountAtomic,
        expiresAt: purchase.expiresAt,
        mandateHash: purchase.mandateHash,
        policyHash: purchase.policyHash,
        paymentAuthorizationHash: purchase.paymentAuthorizationHash!,
      };

      // A submitted hash is authoritative. Reconcile it first and never issue
      // another transaction while it may still be mined.
      if (failed.transactionHash) {
        const authorizationConfirmed = await this.authorizeAnchor(anchorInput, requestId);
        if (authorizationConfirmed) {
          if (purchase.payment?.status === "SETTLED") {
            await this.completeAfterRecoveredAuthorization(purchase, requestId);
          } else {
            await this.markAuthorizationSignatureUnavailable(
              purchase.taskId,
              purchase.id,
              requestId,
            );
          }
          return;
        }
        const refreshed = await this.dependencies.prisma.onchainAnchor.findUnique({
          where: { purchaseId_kind: { purchaseId, kind: "AUTHORIZE" } },
        });
        if (refreshed?.transactionHash) return;
        // A receipt that is conclusively reverted clears the hash. The contract
        // is still NONE, so this same retry may safely negotiate fresh evidence.
      }

      if (purchase.payment?.status === "SETTLED") {
        const authorizationConfirmed = await this.authorizeAnchor(anchorInput, requestId);
        if (authorizationConfirmed) {
          await this.completeAfterRecoveredAuthorization(purchase, requestId);
        }
        return;
      }
      if (purchase.payment?.status === "SETTLEMENT_PENDING") {
        await this.markAuthorizationSignatureUnavailable(purchase.taskId, purchase.id, requestId);
        return;
      }

      await this.retryAuthorizationWithFreshPayment(purchase, anchorInput, requestId);
        return;
      }
      if (
        failed.kind === "FINALIZE" &&
        purchase.payment?.transactionHash &&
        purchase.delivery?.responseHash &&
        purchase.invoice?.canonicalHash &&
        purchase.reconciliation?.canonicalHash
      ) {
        const confirmed = await this.finalizeAnchor(
          {
            id: purchase.id,
            actualAmountAtomic: purchase.actualAmountAtomic ?? purchase.expectedAmountAtomic,
            settlementTxHash: purchase.payment.transactionHash,
            receiptHash: purchase.delivery.responseHash,
            invoiceHash: purchase.invoice.canonicalHash,
            reconciliationHash: purchase.reconciliation.canonicalHash,
          },
          requestId,
        );
        if (confirmed) {
          await this.markCompleted(
            purchase.id,
            purchase.taskId,
            purchase.paymentId,
            purchase.service.sellerId,
            purchase.invoice.status,
            requestId,
          );
        }
        return;
      }
      if (failed.kind === "FAIL") {
        const confirmed = await this.failureAnchor(
          {
            id: purchase.id,
            errorCode: purchase.task.errorCode ?? "TASK_FAILED",
          },
          requestId,
        );
        if (!confirmed) {
          throw new MelloError("CONTRACT_ANCHOR_FAILED", "Failure anchor is still pending", {
            statusCode: 409,
            retryable: true,
          });
        }
        return;
      }
      throw new MelloError("CONTRACT_ANCHOR_FAILED", "Anchor evidence is incomplete", {
        statusCode: 409,
      });
    } finally {
      await this.dependencies.prisma.onchainAnchor.updateMany({
        where: { id: failed.id, retryClaimId: claimId },
        data: { retryClaimId: null, retryClaimedAt: null },
      });
    }
  }

  private async execute(taskId: string, requestId?: string): Promise<void> {
    const { prisma, agent, paymentProvider, config } = this.dependencies;
    const [task, companyRecord, policyRecord, serviceRecords] = await Promise.all([
      prisma.task.findUniqueOrThrow({ where: { id: taskId }, include: { control: true } }),
      prisma.companyProfile.findFirstOrThrow({ orderBy: { createdAt: "asc" } }),
      prisma.policy.findFirstOrThrow({ where: { active: true } }),
      prisma.service.findMany({
        where: {
          category: "credit_report",
          seller: { status: "ACTIVE" },
        },
        include: { seller: true },
      }),
    ]);
    const company: CompanyProfileInput = {
      legalName: companyRecord.legalName,
      businessId: companyRecord.businessId,
      email: companyRecord.email,
      defaultCostCenter: companyRecord.defaultCostCenter,
    };
    const policy: ActivePolicy = {
      id: policyRecord.id,
      version: policyRecord.version,
      ...PolicyInputSchema.parse({
        perTxLimitAtomic: policyRecord.perTxLimitAtomic,
        dailyLimitAtomic: policyRecord.dailyLimitAtomic,
        requireTwInvoice: policyRecord.requireTwInvoice,
        allowedNetworks: policyRecord.allowedNetworks,
        allowedTokens: policyRecord.allowedTokens,
        allowedSellerIds: policyRecord.allowedSellerIds,
      }),
    };
    let services = serviceRecords.map((service) =>
      ServiceRecordSchema.parse({
        ...service,
        sellerLegalName: service.seller.legalName,
        sellerBusinessId: service.seller.businessId,
        payToAddress: service.seller.payToAddress,
        invoiceCapability: service.seller.invoiceCapability,
        invoiceProvider: service.seller.invoiceProvider,
      }),
    );

    const requirements = task.control?.requirements ? TaskRequirementsSchema.parse(task.control.requirements) : null;
    const selection = task.control?.selectedService ? ServiceSelectionSchema.parse(task.control.selectedService) : null;
    const parsed = selection && task.intent ? {
      intent: PurchaseIntentSchema.parse(task.intent), usedFallback: task.usedFallbackParser,
    } : await agent.parse({
      prompt: task.prompt,
      company,
      policyPerTxLimitAtomic: policy.perTxLimitAtomic,
    });
    // Explicit form choices are authoritative over prose or model inference.
    if (requirements) parsed.intent.requiresTwInvoice = requirements.requiresTwInvoice;
    await this.setTaskStage(taskId, "DISCOVERING", "INTENT_PARSED", parsed.intent, requestId, {
      intent: jsonValue(parsed.intent),
      usedFallbackParser: parsed.usedFallback,
    });

    const discovery = config.SERVICE_DISCOVERY_MODE === "bazaar"
      ? await this.registry.discover(requirements?.requiresRegistryCertification ?? true)
      : requirements ? await this.registry.discoverLocal(requirements.requiresRegistryCertification) : null;
    if (discovery) services = discovery.services;
    await appendAuditEvent(prisma, {
      aggregateType: "TASK", aggregateId: taskId, taskId, requestId, stage: "DISCOVERING",
      eventType: "SERVICE_DISCOVERY_COMPLETED",
      payload: discovery ? {
        source: discovery.source, fetchedAt: discovery.fetchedAt,
        partialResults: discovery.partialResults, discoveredResourceCount: discovery.discoveredResourceCount,
        unregisteredResourceCount: discovery.unregisteredResourceCount, rejectedResourceCount: discovery.rejectedResourceCount,
        localFallbackUsed: false,
      } : { source: "local_demo", localFallbackUsed: false, bazaarQueried: false },
    });
    const candidates = evaluateCandidates({ intent: parsed.intent, policy, services }).map((candidate) => {
      const assessment = discovery?.assessments.find((item) => item.serviceId === candidate.serviceId);
      if (requirements) {
        const service = services.find((item) => item.id === candidate.serviceId)!;
        return surveyCandidate(candidate, service, requirements,
          assessment?.verification ?? { status: "UNREVIEWED", revision: null },
          assessment?.reasonCodes ?? [], discovery?.source);
      }
      if (!assessment) return candidate;
      const reasons = [...(candidate.eligible ? [] : candidate.reasonCodes), ...assessment.reasonCodes];
      return { ...candidate, discoverySource: "cdp_bazaar", verificationStatus: assessment.verification.status,
        eligible: reasons.length === 0, reasonCodes: reasons.length ? reasons : ["CANDIDATE_ELIGIBLE", "BAZAAR_VERIFICATION_MATCHED"],
        humanSummary: reasons.length ? `未通過：${reasons.join("、")}` : `${candidate.sellerLegalName} 的 Bazaar 服務、Mello 認證與企業政策均通過。`,
      };
    });
    await this.setTaskStage(
      taskId,
      "EVALUATING",
      "SERVICE_CANDIDATES_EVALUATED",
      { candidates },
      requestId,
      { candidates: jsonValue(candidates) },
    );
    const selectedCandidate = requirements
      ? candidates.find((candidate) => candidate.serviceId === selection?.serviceId && candidate.eligible &&
        "selectionHash" in candidate && candidate.selectionHash === selection.selectionHash)
      : selectCandidate(candidates);
    if (requirements && !selectedCandidate) {
      await prisma.$transaction(async (transaction) => {
        const changed = await transaction.task.updateMany({ where: { id: taskId, status: "EVALUATING" }, data: {
          status: "WAITING_SELECTION", errorCode: null, errorMessage: null,
          decisionSummary: selection
            ? "選用服務的報價或資格已更新，請重新確認服務後送出採購。"
            : "探索完成，請比較服務並選擇要採購的項目。尚未建立付款。",
        } });
        if (changed.count !== 1) throw new MelloError("TASK_ALREADY_RUNNING", "Task changed during survey", { statusCode: 409 });
        await transaction.taskControl.update({ where: { taskId }, data: { selectedService: Prisma.DbNull } });
        await appendAuditEvent(transaction, { aggregateType: "TASK", aggregateId: taskId, taskId, requestId,
          stage: "WAITING_SELECTION", eventType: selection ? "SERVICE_SELECTION_CHANGED" : "SERVICE_SURVEY_READY",
          payload: { requirements, candidateCount: candidates.length, paymentCreated: false } });
      });
      return;
    }
    if (!selectedCandidate) {
      await prisma.$transaction(async (transaction) => {
        const taskTransition = await transaction.task.updateMany({
          where: { id: taskId, status: "EVALUATING" },
          data: {
            status: "REJECTED",
            decisionSummary: "沒有供應商同時符合預算、付款與發票條件。",
            errorCode: "NO_ELIGIBLE_SERVICE",
            completedAt: this.now(),
          },
        });
        if (taskTransition.count !== 1) {
          throw new MelloError("INTERNAL_ERROR", "Task state changed before rejection", {
            statusCode: 409,
            retryable: true,
          });
        }
        await appendAuditEvent(transaction, {
          aggregateType: "TASK",
          aggregateId: taskId,
          taskId,
          requestId,
          stage: "EVALUATING",
          eventType: "TASK_REJECTED",
          payload: { reasonCode: "NO_ELIGIBLE_SERVICE", paymentCreated: false },
        });
      });
      return;
    }
    const selectedService = services.find(
      (service) => service.id === selectedCandidate.serviceId,
    );
    if (!selectedService) throw new Error("Selected registry service disappeared");
    const discoveryEvidence = discovery?.assessments.find((item) => item.serviceId === selectedService.id)?.evidence;
    if (discovery && !discoveryEvidence) throw new MelloError("SERVICE_VERIFICATION_REQUIRED", "服務缺少 Bazaar 認證證據。");

    if (this.dependencies.controls && !await this.dependencies.controls.assess(taskId, selectedService, requestId)) return;

    const purchaseId = randomUUID();
    const paymentId = generatePaymentId();
    const buyerAddress = await paymentProvider.getAddress();
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + 10 * 60 * 1_000);
    const invoiceRequired = parsed.intent.requiresTwInvoice || policy.requireTwInvoice;

    const reservation = await withDailySpendReservationLock(
      prisma,
      { buyerProfileId: companyRecord.id, now: createdAt },
      async ({ reservedAtomic, transaction }) => {
        const policyDecision = evaluatePolicy({
          intent: parsed.intent,
          service: selectedService,
          policy,
          company,
          dailySettledAtomic: reservedAtomic,
          now: createdAt,
        });
        if (!policyDecision.approved) {
          const taskTransition = await transaction.task.updateMany({
            where: { id: taskId, status: "EVALUATING" },
            data: {
              status: "REJECTED",
              decisionSummary: `企業政策拒絕：${policyDecision.reasonCodes.join("、")}`,
              errorCode: "POLICY_REJECTED",
              completedAt: createdAt,
            },
          });
          if (taskTransition.count !== 1) {
            throw new MelloError("INTERNAL_ERROR", "Task state changed before policy rejection", {
              statusCode: 409,
              retryable: true,
            });
          }
          await appendAuditEvent(transaction, {
            aggregateType: "TASK",
            aggregateId: taskId,
            taskId,
            requestId,
            stage: "EVALUATING",
            eventType: "POLICY_REJECTED",
            payload: { ...policyDecision, paymentCreated: false },
          });
          return { approved: false as const };
        }

        const policySnapshot = { ...policy, evaluatedAt: policyDecision.evaluatedAt };
        const mandateHash = hashCanonicalJson({
          schemaVersion: "1",
          purchaseId,
          buyerWallet: buyerAddress,
          sellerWallet: selectedService.payToAddress,
          serviceId: selectedService.id,
          maxAmountAtomic: parsed.intent.maxAmount.atomic,
          token: selectedService.tokenSymbol,
          network: selectedService.network,
          expiresAt: expiresAt.toISOString(),
        });
        const policyHash = hashCanonicalJson({ schemaVersion: "1", ...policySnapshot });

      await transaction.purchase.create({
        data: {
          id: purchaseId,
          taskId,
          buyerProfileId: companyRecord.id,
          serviceId: selectedService.id,
          buyerProfileSnapshot: jsonValue(invoiceBuyerProfile(companyRecord)),
          paymentId,
          ...capturePurchaseRuntimeEvidence(config),
          ...(discoveryEvidence ? { discoveryEvidence: jsonValue(discoveryEvidence) } : {}),
          expectedAmountAtomic: selectedService.priceAtomic,
          network: selectedService.network,
          tokenSymbol: selectedService.tokenSymbol,
          tokenAddress: selectedService.tokenAddress,
          tokenDecimals: selectedService.tokenDecimals,
          buyerAddress,
          payToAddress: selectedService.payToAddress,
          policySnapshot: jsonValue(policySnapshot),
          mandateHash,
          policyHash,
          expiresAt,
          createdAt,
          status: "CREATED",
          payment: { create: { paymentId, status: "NOT_STARTED" } },
          delivery: { create: { status: "PENDING" } },
          invoice: {
            create: {
              status: invoiceRequired ? "PENDING" : "NOT_REQUIRED",
              provider: "MOCK",
              canonicalHash: invoiceRequired ? null : notRequiredInvoiceEvidenceHash(purchaseId),
              disclaimer: invoiceRequired
                ? "電子發票模擬紀錄，非正式統一發票"
                : "本次採購不需要發票；仍保存 NOT_REQUIRED 稽核證據。",
            },
          },
          reconciliation: { create: { status: "PENDING", checks: [] } },
          anchors: {
            create: [
              { kind: "AUTHORIZE", status: "NOT_STARTED" },
              { kind: "FINALIZE", status: "NOT_STARTED" },
              { kind: "FAIL", status: "NOT_STARTED" },
            ],
          },
        },
      });
      const purchaseCreated = await transaction.task.updateMany({
        where: { id: taskId, status: "EVALUATING" },
        data: {
          status: "EVALUATING",
          decisionSummary: `Registry candidate ${selectedService.sellerLegalName} selected；正在驗證 live 402 payment terms。`,
        },
      });
      if (purchaseCreated.count !== 1) {
        throw new MelloError("INTERNAL_ERROR", "Task state changed while creating purchase", {
          statusCode: 409,
          retryable: true,
        });
      }
      await appendAuditEvent(transaction, {
        aggregateType: "PURCHASE",
        aggregateId: purchaseId,
        taskId,
        purchaseId,
        paymentId,
        sellerId: selectedService.sellerId,
        requestId,
        stage: "EVALUATING",
        eventType: "PURCHASE_CREATED_PENDING_LIVE_TERMS",
        payload: {
          serviceId: selectedService.id,
          liveTermsPolicyApproved: false,
          paidRequestReleased: false,
        },
      });
        return { approved: true as const, mandateHash, policyHash, policyDecision };
      },
    );
    if (!reservation.approved) return;
    const { mandateHash, policyHash, policyDecision } = reservation;

    const purchaseContextToken = createPurchaseContextToken(
      {
        purchaseId,
        buyerProfileId: companyRecord.id,
        sellerId: selectedService.sellerId,
      },
      config.SELLER_CONTEXT_HMAC_SECRET,
    );
    let rejectedBeforeSigning = false;
    const evaluateLiveTerms = (livePaymentTerms: PreparedPayment["validatedTerms"]) =>
      evaluatePolicy({
        intent: parsed.intent,
        service: selectedService,
        policy,
        company,
        dailySettledAtomic: policyDecision.dailySpendBeforeAtomic,
        livePaymentTerms,
        expectedFacilitatorUrl: config.X402_FACILITATOR_URL,
        now: createdAt,
      });
    const persistLiveTermsRejection = async (
      livePaymentTerms: PreparedPayment["validatedTerms"],
      decision: ReturnType<typeof evaluatePolicy>,
    ): Promise<void> => {
      await prisma.$transaction(async (transaction) => {
        await transitionPurchaseWorkflowStage(transaction, {
          taskId,
          purchaseId,
          expectedTaskStatuses: ["EVALUATING"],
          expectedPurchaseStatuses: ["CREATED"],
          nextTaskStatus: "REJECTED",
          nextPurchaseStatus: "FAILED",
          taskData: {
            decisionSummary: `Live 402 terms rejected：${decision.reasonCodes.join("、")}`,
            errorCode: "POLICY_REJECTED",
            completedAt: this.now(),
          },
          aggregateType: "PURCHASE",
          aggregateId: purchaseId,
          paymentId,
          sellerId: selectedService.sellerId,
          requestId,
          stage: "EVALUATING",
          eventType: "POLICY_REJECTED",
          payload: {
            ...decision,
            livePaymentTerms,
            paymentCreated: false,
            rejectedBeforeSigning: true,
          },
        });
      });
      rejectedBeforeSigning = true;
    };

    let prepared: PreparedPayment;
    try {
      if (discoveryEvidence) await this.registry.assertPurchasable(selectedService.id, discoveryEvidence);
      prepared = await paymentProvider.prepare({
        taskId,
        ...(requestId ? { requestId } : {}),
        purchaseId,
        paymentId,
        sellerId: selectedService.sellerId,
        endpoint: selectedService.endpoint,
        targetCompanyName: parsed.intent.targetCompanyName,
        purchaseContextToken,
        requiresTwInvoice: invoiceRequired,
        network: selectedService.network,
        tokenAddress: selectedService.tokenAddress as `0x${string}`,
        payerAddress: buyerAddress,
        payToAddress: selectedService.payToAddress as `0x${string}`,
        amountAtomic: selectedService.priceAtomic,
        authorizationTtlSeconds: config.ERC3009_AUTH_TTL_SECONDS,
        maximumValidBefore: maximumAuthorizationValidBefore(expiresAt),
        expectedFacilitatorUrl: config.X402_FACILITATOR_URL,
        onLivePaymentTerms: async (livePaymentTerms) => {
          if (discoveryEvidence) await this.registry.assertPurchasable(selectedService.id, discoveryEvidence);
          const decision = evaluateLiveTerms(livePaymentTerms);
          if (decision.approved) return;
          await persistLiveTermsRejection(livePaymentTerms, decision);
          throw new MelloError(
            "POLICY_REJECTED",
            `Live 402 terms rejected: ${decision.reasonCodes.join(", ")}`,
            { statusCode: 409, details: { reasonCodes: decision.reasonCodes } },
          );
        },
      });
    } catch (error: unknown) {
      if (rejectedBeforeSigning) return;
      throw error;
    }

    const livePolicyDecision = evaluateLiveTerms(prepared.validatedTerms);
    if (!livePolicyDecision.approved) {
      prepared.cancel("Live 402 payment terms failed enterprise policy");
      await persistLiveTermsRejection(prepared.validatedTerms, livePolicyDecision);
      return;
    }
    await prisma.$transaction(async (transaction) => {
      await transitionPurchaseWorkflowStage(transaction, {
        taskId,
        purchaseId,
        expectedTaskStatuses: ["EVALUATING"],
        expectedPurchaseStatuses: ["CREATED"],
        nextTaskStatus: "AUTH_ANCHOR_PENDING",
        nextPurchaseStatus: "AUTH_ANCHOR_PENDING",
        taskData: {
          decisionSummary: `選擇 ${selectedService.sellerLegalName}：live 402 terms 已通過政策，價格為 ${selectedService.priceAtomic} atomic USDC。`,
        },
        aggregateType: "PURCHASE",
        aggregateId: purchaseId,
        paymentId,
        sellerId: selectedService.sellerId,
        requestId,
        stage: "EVALUATING",
        eventType: "POLICY_APPROVED",
        payload: {
          ...livePolicyDecision,
          livePaymentTerms: prepared.validatedTerms,
          offchainAuthorizationFallbackEnabled: config.DEMO_ALLOW_OFFCHAIN_AUTH,
        },
      });
    });

    await this.persistPreparedAuthorization({
      taskId,
      purchaseId,
      paymentId,
      sellerId: selectedService.sellerId,
      buyerAddress,
      payToAddress: selectedService.payToAddress,
      amountAtomic: selectedService.priceAtomic,
      network: selectedService.network,
      tokenAddress: selectedService.tokenAddress,
      prepared,
      requestId,
      retry: false,
    });

    const authorizationAnchorConfirmed = await this.authorizeAnchor(
      {
        id: purchaseId,
        buyerAddress,
        payToAddress: selectedService.payToAddress,
        tokenAddress: selectedService.tokenAddress,
        maxAmountAtomic: parsed.intent.maxAmount.atomic,
        expiresAt,
        mandateHash,
        policyHash,
        paymentAuthorizationHash: prepared.authorizationHash,
      },
      requestId,
    );
    if (!authorizationAnchorConfirmed && !config.DEMO_ALLOW_OFFCHAIN_AUTH) {
      prepared.cancel("Authorization anchor was not confirmed");
      await this.markActionRequired(
        taskId,
        purchaseId,
        "CONTRACT_ANCHOR_FAILED",
        "Authorization anchor failed before payment; no payment was submitted.",
        requestId,
      );
      return;
    }
    if (!authorizationAnchorConfirmed) {
      await this.appendPaymentLifecycleEvent({
        taskId,
        purchaseId,
        paymentId,
        sellerId: selectedService.sellerId,
        requestId,
        stage: "AUTH_ANCHOR_PENDING",
        eventType: "AUTHORIZATION_ANCHOR_FALLBACK_USED",
        payload: {
          displayStatus: "AUTH_ANCHOR_PENDING",
          paymentMayContinue: true,
          anchorConfirmed: false,
          retryRequired: true,
        },
      });
    }

    await this.submitPreparedPaymentAndContinue({
      taskId,
      purchaseId,
      paymentId,
      sellerId: selectedService.sellerId,
      prepared,
      authorizationAnchorConfirmed,
      requestId,
    });
  }

  private async persistPreparedAuthorization(input: {
    taskId: string;
    purchaseId: string;
    paymentId: string;
    sellerId: string;
    buyerAddress: string;
    payToAddress: string;
    amountAtomic: string;
    network: string;
    tokenAddress: string;
    prepared: PreparedPayment;
    requestId: string | undefined;
    retry: boolean;
    refreshedMandate?: { expiresAt: Date; mandateHash: string } | undefined;
  }): Promise<void> {
    const createdAt = this.now();
    const authorizationData = {
      paymentId: input.prepared.authorization.paymentId,
      standard: "ERC3009",
      scheme: "exact",
      network: input.network,
      tokenAddress: input.prepared.authorization.tokenAddress,
      fromAddress: input.prepared.authorization.from,
      toAddress: input.prepared.authorization.to,
      amountAtomic: input.prepared.authorization.value,
      nonce: input.prepared.authorization.nonce.toLowerCase(),
      validAfter: input.prepared.authorization.validAfter,
      validBefore: input.prepared.authorization.validBefore,
      eip712Name: input.prepared.authorization.eip712Domain.name,
      eip712Version: input.prepared.authorization.eip712Domain.version,
      eip712ChainId: BigInt(input.prepared.authorization.eip712Domain.chainId),
      typedDataHash: input.prepared.authorization.typedDataHash,
      signatureHash: input.prepared.authorization.signatureHash ?? null,
      status: input.prepared.authorization.status,
      settlementTxHash: null,
    } as const;
    try {
      await withAuthorizationNonceReservation(
        this.dependencies.prisma,
        {
          purchaseId: input.purchaseId,
          paymentId: input.prepared.authorization.paymentId,
          nonce: input.prepared.authorization.nonce,
          typedDataHash: input.prepared.authorization.typedDataHash,
          createdAt,
        },
        async (transaction, normalizedNonce) => {
          const purchaseTransition = await transaction.purchase.updateMany({
            where: {
              id: input.purchaseId,
              taskId: input.taskId,
              status: input.retry ? "ACTION_REQUIRED" : "AUTH_ANCHOR_PENDING",
            },
            data: {
              paymentAuthorizationHash: input.prepared.authorizationHash,
              status: "AUTH_ANCHOR_PENDING",
              ...(input.refreshedMandate ?? {}),
            },
          });
          const taskTransition = await transaction.task.updateMany({
            where: {
              id: input.taskId,
              status: input.retry ? "ACTION_REQUIRED" : "AUTH_ANCHOR_PENDING",
            },
            data: {
              status: "AUTH_ANCHOR_PENDING",
              errorCode: null,
              errorMessage: null,
            },
          });
          await transaction.paymentAuthorization.upsert({
            where: { purchaseId: input.purchaseId },
            create: {
              purchaseId: input.purchaseId,
              ...authorizationData,
            },
            update: authorizationData,
          });
          const paymentTransition = await transaction.payment.updateMany({
            where: {
              purchaseId: input.purchaseId,
              status: input.retry ? "AUTHORIZED" : "NOT_STARTED",
            },
            data: {
              status: "AUTHORIZED",
              payerAddress: input.buyerAddress,
              payeeAddress: input.payToAddress,
              amountAtomic: input.amountAtomic,
              network: input.network,
              tokenAddress: input.tokenAddress,
              paymentRequired: jsonValue(input.prepared.paymentRequired),
              authorizedAt: this.now(),
            },
          });
          if (
            purchaseTransition.count !== 1 ||
            taskTransition.count !== 1 ||
            paymentTransition.count !== 1
          ) {
            throw new MelloError(
              "INTERNAL_ERROR",
              "Authorization state changed before evidence was persisted",
              { statusCode: 409, retryable: true },
            );
          }
          const authorizationEventPayload = {
            typedDataHash: input.prepared.authorization.typedDataHash,
            authorizationHash: input.prepared.authorizationHash,
            nonce: normalizedNonce,
            validAfter: input.prepared.authorization.validAfter.toString(),
            validBefore: input.prepared.authorization.validBefore.toString(),
            retry: input.retry,
          };
          await appendAuditEvent(transaction, {
            aggregateType: "PAYMENT",
            aggregateId: input.paymentId,
            taskId: input.taskId,
            purchaseId: input.purchaseId,
            paymentId: input.paymentId,
            sellerId: input.sellerId,
            requestId: input.requestId,
            stage: "AUTH_ANCHOR_PENDING",
            eventType: "AUTHORIZATION_CREATED",
            payload: authorizationEventPayload,
          });
          await appendAuditEvent(transaction, {
            aggregateType: "PAYMENT",
            aggregateId: input.paymentId,
            taskId: input.taskId,
            purchaseId: input.purchaseId,
            paymentId: input.paymentId,
            sellerId: input.sellerId,
            requestId: input.requestId,
            stage: "AUTH_ANCHOR_PENDING",
            eventType:
              input.prepared.authorization.status === "SIGNED"
                ? "AUTHORIZATION_SIGNED"
                : "AUTHORIZATION_SIMULATED",
            payload: authorizationEventPayload,
          });
          if (input.retry) {
            await appendAuditEvent(transaction, {
              aggregateType: "PAYMENT",
              aggregateId: input.paymentId,
              taskId: input.taskId,
              purchaseId: input.purchaseId,
              paymentId: input.paymentId,
              sellerId: input.sellerId,
              requestId: input.requestId,
              stage: "AUTH_ANCHOR_PENDING",
              eventType: "AUTHORIZATION_RENEGOTIATED",
              payload: authorizationEventPayload,
            });
          }
        },
      );
    } catch (error: unknown) {
      input.prepared.cancel("Authorization evidence could not be persisted safely");
      throw error;
    }
  }

  private async submitPreparedPaymentAndContinue(input: {
    taskId: string;
    purchaseId: string;
    paymentId: string;
    sellerId: string;
    prepared: PreparedPayment;
    authorizationAnchorConfirmed: boolean;
    requestId: string | undefined;
  }): Promise<void> {
    const { prisma, paymentProvider } = this.dependencies;
    await prisma.$transaction(async (transaction) => {
      const paymentTransition = await transaction.payment.updateMany({
        where: { purchaseId: input.purchaseId, status: "AUTHORIZED" },
        data: { status: "SETTLEMENT_PENDING" },
      });
      if (paymentTransition.count !== 1) {
        throw new MelloError("INTERNAL_ERROR", "Payment state changed before submission", {
          statusCode: 409,
          retryable: true,
        });
      }
      await transitionPurchaseWorkflowStage(transaction, {
        taskId: input.taskId,
        purchaseId: input.purchaseId,
        expectedTaskStatuses: ["AUTH_ANCHOR_PENDING"],
        expectedPurchaseStatuses: ["AUTH_ANCHOR_PENDING", "AUTHORIZED"],
        nextTaskStatus: "PAYING",
        nextPurchaseStatus: "PAYING",
        aggregateType: "PAYMENT",
        aggregateId: input.paymentId,
        paymentId: input.paymentId,
        sellerId: input.sellerId,
        requestId: input.requestId,
        stage: "PAYING",
        eventType: "PAYMENT_SUBMISSION_INTENT_RECORDED",
        payload: {
          mode: paymentProvider.mode,
          authorizationAnchorConfirmed: input.authorizationAnchorConfirmed,
          paidRequestReleased: false,
        },
      });
    });

    let settlement: PaymentSettlement;
    let paidRequestReleased = false;
    try {
      settlement = await input.prepared.submit({
        onBeforePaidRequest: async () => {
          await this.registry.assertPurchase(input.purchaseId, this.dependencies.config.SERVICE_DISCOVERY_MODE === "bazaar");
          await this.registry.withPurchaseRelease(input.purchaseId, this.dependencies.config.SERVICE_DISCOVERY_MODE === "bazaar", async (tx) => {
            await this.dependencies.controls?.claimPaymentRelease(input.taskId, input.purchaseId, input.requestId, tx);
          }, input.requestId);
          await this.appendPaymentLifecycleEvent({
            taskId: input.taskId,
            purchaseId: input.purchaseId,
            paymentId: input.paymentId,
            sellerId: input.sellerId,
            requestId: input.requestId,
            eventType: "PAID_REQUEST_RELEASE_AUTHORIZED",
            stage: "PAYING",
            payload: {
              mode: paymentProvider.mode,
              boundary: "BEFORE_SIGNED_PAID_REQUEST_RELEASE",
              paidRequestReleased: false,
            },
          });
        },
        onPaidRequestReleased: async () => {
          paidRequestReleased = true;
          await this.recordPaidRequestReleased({
            taskId: input.taskId,
            purchaseId: input.purchaseId,
            paymentId: input.paymentId,
            sellerId: input.sellerId,
            requestId: input.requestId,
            mode: paymentProvider.mode,
          });
        },
      });
    } catch (error: unknown) {
      if (error instanceof SettledPaymentDeliveryError) {
        await this.recordSettledDeliveryFailure({
          taskId: input.taskId,
          purchaseId: input.purchaseId,
          sellerId: input.sellerId,
          error,
          ...(input.requestId ? { requestId: input.requestId } : {}),
        });
        return;
      }
      await this.recordPendingSettlementReconciliation({
        taskId: input.taskId,
        purchaseId: input.purchaseId,
        paymentId: input.paymentId,
        sellerId: input.sellerId,
        error,
        paidRequestReleased,
        authorizationStatus: input.prepared.authorization.status,
        requestId: input.requestId,
      });
      return;
    }
    const responseHash = hashCanonicalJson({
      schemaVersion: "1",
      report: settlement.report,
    });
    await prisma.$transaction(async (transaction) => {
      const paymentTransition = await transaction.payment.updateMany({
        where: { purchaseId: input.purchaseId, status: "SETTLEMENT_PENDING" },
        data: {
          status: "SETTLED",
          transactionHash: settlement.transactionHash,
          payerAddress: settlement.payerAddress,
          payeeAddress: settlement.payeeAddress,
          amountAtomic: settlement.amountAtomic,
          network: settlement.network,
          tokenAddress: settlement.tokenAddress,
          paymentResponse: jsonValue(settlement.paymentResponse),
          settledAt: this.now(),
        },
      });
      const authorizationTransition = await transaction.paymentAuthorization.updateMany({
        where: { purchaseId: input.purchaseId, status: "SUBMITTED" },
        data: { status: "SETTLED", settlementTxHash: settlement.transactionHash },
      });
      const deliveryTransition = await transaction.delivery.updateMany({
        where: { purchaseId: input.purchaseId, status: "PENDING" },
        data: {
          status: "DELIVERED",
          responseBody: jsonValue(settlement.report),
          responseHash,
          deliveredAt: this.now(),
        },
      });
      if (
        paymentTransition.count !== 1 ||
        authorizationTransition.count !== 1 ||
        deliveryTransition.count !== 1
      ) {
        throw new MelloError("INTERNAL_ERROR", "Settlement state changed before delivery", {
          statusCode: 409,
          retryable: true,
          details: {
            paymentTransitions: paymentTransition.count,
            authorizationTransitions: authorizationTransition.count,
            deliveryTransitions: deliveryTransition.count,
          },
        });
      }
      await this.appendVerifiedFacilitatorLifecycle(transaction, {
        taskId: input.taskId,
        purchaseId: input.purchaseId,
        paymentId: input.paymentId,
        sellerId: input.sellerId,
        requestId: input.requestId,
        transactionHash: settlement.transactionHash,
        verifiedChainId: settlement.verifiedChainId,
        recovered: false,
      });
      await transitionPurchaseWorkflowStage(transaction, {
        taskId: input.taskId,
        purchaseId: input.purchaseId,
        expectedTaskStatuses: ["PAYING"],
        expectedPurchaseStatuses: ["PAYING"],
        nextTaskStatus: "DELIVERING",
        nextPurchaseStatus: "DELIVERED",
        purchaseData: {
          actualAmountAtomic: settlement.amountAtomic,
          paymentExplorerBase: paymentExplorerBaseForVerifiedSettlement(
            this.dependencies.config,
            settlement,
          ),
        },
        aggregateType: "PAYMENT",
        aggregateId: input.paymentId,
        paymentId: input.paymentId,
        sellerId: input.sellerId,
        requestId: input.requestId,
        stage: "DELIVERING",
        eventType: "PAYMENT_SETTLEMENT_AND_DELIVERY_CONFIRMED",
        payload: {
          transactionHash: settlement.transactionHash,
          amountAtomic: settlement.amountAtomic,
          responseHash,
          mode: paymentProvider.mode,
          verifiedChainId: settlement.verifiedChainId ?? null,
          settlementEvidenceValidated: true,
          settlementReceiptVerified: paymentProvider.mode === "x402",
        },
      });
    });
    await this.startInvoicing({
      taskId: input.taskId,
      purchaseId: input.purchaseId,
      paymentId: input.paymentId,
      sellerId: input.sellerId,
      requestId: input.requestId,
      transactionHash: settlement.transactionHash,
    });

    await this.issueInvoiceAndComplete(input.purchaseId, input.requestId);
  }

  private async startInvoicing(input: {
    taskId: string;
    purchaseId: string;
    paymentId: string;
    sellerId: string;
    requestId: string | undefined;
    transactionHash: string;
  }): Promise<void> {
    await this.dependencies.prisma.$transaction(async (transaction) => {
      const [task, purchase] = await Promise.all([
        transaction.task.findUnique({ where: { id: input.taskId }, select: { status: true } }),
        transaction.purchase.findUnique({
          where: { id: input.purchaseId },
          select: { status: true },
        }),
      ]);
      if (task?.status === "INVOICING" && purchase?.status === "INVOICING") return;
      await transitionPurchaseWorkflowStage(transaction, {
        taskId: input.taskId,
        purchaseId: input.purchaseId,
        expectedTaskStatuses: ["DELIVERING", "ACTION_REQUIRED"],
        expectedPurchaseStatuses: ["DELIVERED", "ACTION_REQUIRED"],
        nextTaskStatus: "INVOICING",
        nextPurchaseStatus: "INVOICING",
        taskData: { errorCode: null, errorMessage: null },
        aggregateType: "PURCHASE",
        aggregateId: input.purchaseId,
        paymentId: input.paymentId,
        sellerId: input.sellerId,
        requestId: input.requestId,
        stage: "INVOICING",
        eventType: "INVOICING_STARTED",
        payload: {
          transactionHash: input.transactionHash,
          previousTaskStatus: task?.status ?? null,
          previousPurchaseStatus: purchase?.status ?? null,
        },
      });
    });
  }

  private async retryAuthorizationWithFreshPayment(
    purchase: {
      id: string;
      taskId: string;
      paymentId: string;
      serviceId: string;
      expectedAmountAtomic: string;
      network: string;
      tokenSymbol: string;
      tokenAddress: string;
      buyerAddress: string;
      payToAddress: string;
      policySnapshot: Prisma.JsonValue;
      expiresAt: Date;
      mandateHash: string;
      policyHash: string;
      task: { intent: Prisma.JsonValue | null };
      service: { sellerId: string; endpoint: string };
      authorization: { nonce: string } | null;
    },
    anchorInput: AuthorizationAnchorInput,
    requestId?: string,
  ): Promise<void> {
    const { anchorClient, config, paymentProvider, prisma } = this.dependencies;
    await this.registry.assertPurchase(purchase.id, config.SERVICE_DISCOVERY_MODE === "bazaar");
    if (anchorClient.mode === "disabled") {
      await this.markActionRequired(
        purchase.taskId,
        purchase.id,
        "CONTRACT_ANCHOR_FAILED",
        "Authorization anchoring is disabled; payment was not submitted.",
        requestId,
      );
      return;
    }

    let chainState;
    try {
      chainState = await anchorClient.getPurchaseState(purchase.id);
    } catch (error: unknown) {
      await this.anchorFailed(purchase.id, "AUTHORIZE", error, requestId);
      return;
    }
    if (chainState.status !== "NONE") {
      await this.markActionRequired(
        purchase.taskId,
        purchase.id,
        "CONTRACT_ANCHOR_FAILED",
        chainState.status === "AUTHORIZED"
          ? "The authorization is already on-chain, but its transaction hash and payment signature are unavailable; automatic payment recovery is unsafe."
          : `The on-chain purchase is ${chainState.status}; a new authorization cannot replace its immutable evidence.`,
        requestId,
        "AUTHORIZATION_SIGNATURE_UNAVAILABLE",
      );
      return;
    }

    const intent = purchase.task.intent as {
      targetCompanyName?: string;
      requiresTwInvoice?: boolean;
      buyerBusinessId?: string;
      maxAmount?: { atomic?: string };
    } | null;
    const policyInput = PolicyInputSchema.parse(purchase.policySnapshot);
    const policySnapshot = purchase.policySnapshot as Record<string, unknown>;
    const policyVersion =
      typeof policySnapshot["version"] === "number" &&
      Number.isInteger(policySnapshot["version"]) &&
      policySnapshot["version"] > 0
        ? policySnapshot["version"]
        : 1;
    const policy = { ...policyInput, version: policyVersion };
    const company = await prisma.companyProfile.findFirstOrThrow({
      orderBy: { createdAt: "asc" },
    });
    const now = this.now();
    const expiresAt =
      purchase.expiresAt.getTime() > now.getTime()
        ? purchase.expiresAt
        : new Date(now.getTime() + 10 * 60 * 1_000);
    const maxAmountAtomic = intent?.maxAmount?.atomic ?? purchase.expectedAmountAtomic;
    const mandateHash =
      expiresAt === purchase.expiresAt
        ? purchase.mandateHash
        : hashCanonicalJson({
            schemaVersion: "1",
            purchaseId: purchase.id,
            buyerWallet: purchase.buyerAddress,
            sellerWallet: purchase.payToAddress,
            serviceId: purchase.serviceId,
            maxAmountAtomic,
            token: purchase.tokenSymbol,
            network: purchase.network,
            expiresAt: expiresAt.toISOString(),
          });
    const sellerId = purchase.service.sellerId;
    if (sellerId !== "seller-a" && sellerId !== "seller-b") {
      throw new MelloError("X402_REQUIREMENTS_INVALID", "Seller is not supported by P0");
    }
    const purchaseContextToken = createPurchaseContextToken(
      {
        purchaseId: purchase.id,
        buyerProfileId: company.id,
        sellerId,
      },
      config.SELLER_CONTEXT_HMAC_SECRET,
    );
    const serviceSnapshot = ServiceRecordSchema.parse({
      id: purchase.serviceId,
      sellerId,
      sellerLegalName: sellerId,
      sellerBusinessId: null,
      payToAddress: purchase.payToAddress,
      invoiceCapability: sellerId === "seller-b" ? "TW_B2B_DEMO" : "NONE",
      invoiceProvider: sellerId === "seller-b" ? "MOCK" : "NONE",
      category: "credit_report",
      endpoint: purchase.service.endpoint,
      method: "POST",
      priceAtomic: purchase.expectedAmountAtomic,
      tokenSymbol: purchase.tokenSymbol,
      tokenAddress: purchase.tokenAddress,
      tokenDecimals: 6,
      network: purchase.network,
      supportsTwInvoice: sellerId === "seller-b",
      active: true,
    });
    const retryIntent = {
      serviceCategory: "credit_report" as const,
      targetCompanyName: intent?.targetCompanyName ?? "Example Co.",
      maxAmount: {
        atomic: maxAmountAtomic,
        display: maxAmountAtomic,
        token: "USDC" as const,
      },
      requiresTwInvoice: intent?.requiresTwInvoice === true,
      buyerBusinessId: intent?.buyerBusinessId ?? "00000000",
      costCenter: "PURCHASE_SNAPSHOT",
      networkPreference: purchase.network as "eip155:84532",
      usedDemoDefaultTarget: false,
    };
    const evaluateRetryLiveTerms = (
      livePaymentTerms: PreparedPayment["validatedTerms"],
    ) =>
      evaluatePolicy({
        intent: retryIntent,
        service: serviceSnapshot,
        policy,
        company: {
          legalName: "Purchase snapshot",
          businessId: retryIntent.buyerBusinessId,
          email: "snapshot@example.test",
          defaultCostCenter: retryIntent.costCenter,
        },
        // The purchase already passed the daily reservation boundary. Retry
        // policy revalidation is intentionally scoped to its immutable quote
        // and live 402 terms rather than double-counting its own reservation.
        dailySettledAtomic: "0",
        livePaymentTerms,
        expectedFacilitatorUrl: config.X402_FACILITATOR_URL,
        now,
      });
    let rejectedBeforeSigning = false;
    const persistRetryLiveTermsRejection = async (
      livePaymentTerms: PreparedPayment["validatedTerms"],
      decision: ReturnType<typeof evaluatePolicy>,
    ): Promise<void> => {
      await prisma.$transaction(async (transaction) => {
        const paymentTransition = await transaction.payment.updateMany({
          where: {
            purchaseId: purchase.id,
            status: { in: ["NOT_STARTED", "AUTHORIZED"] },
          },
          data: { status: "FAILED" },
        });
        const authorizationTransition =
          await transaction.paymentAuthorization.updateMany({
            where: {
              purchaseId: purchase.id,
              status: { in: ["CREATED", "SIGNED"] },
            },
            data: { status: "REJECTED" },
          });
        if (paymentTransition.count !== 1 || authorizationTransition.count !== 1) {
          throw new MelloError(
            "INTERNAL_ERROR",
            "Authorization retry state changed before live policy rejection",
            { statusCode: 409, retryable: true },
          );
        }
        await transitionPurchaseWorkflowStage(transaction, {
          taskId: purchase.taskId,
          purchaseId: purchase.id,
          expectedTaskStatuses: ["ACTION_REQUIRED"],
          expectedPurchaseStatuses: ["ACTION_REQUIRED"],
          nextTaskStatus: "REJECTED",
          nextPurchaseStatus: "FAILED",
          taskData: {
            decisionSummary: `Live 402 retry terms rejected：${decision.reasonCodes.join("、")}`,
            errorCode: "POLICY_REJECTED",
            completedAt: this.now(),
          },
          aggregateType: "PURCHASE",
          aggregateId: purchase.id,
          paymentId: purchase.paymentId,
          sellerId,
          requestId,
          stage: "EVALUATING",
          actorType: "USER",
          eventType: "POLICY_REJECTED",
          payload: {
            ...decision,
            livePaymentTerms,
            retry: true,
            paymentCreated: false,
            rejectedBeforeSigning: true,
          },
        });
      });
      rejectedBeforeSigning = true;
    };

    let prepared: PreparedPayment;
    try {
      prepared = await paymentProvider.prepare({
        taskId: purchase.taskId,
        ...(requestId ? { requestId } : {}),
        purchaseId: purchase.id,
        paymentId: purchase.paymentId,
        sellerId,
        endpoint: purchase.service.endpoint,
        targetCompanyName: retryIntent.targetCompanyName,
        purchaseContextToken,
        requiresTwInvoice: policy.requireTwInvoice || retryIntent.requiresTwInvoice,
        network: purchase.network,
        tokenAddress: purchase.tokenAddress as `0x${string}`,
        payerAddress: purchase.buyerAddress as `0x${string}`,
        payToAddress: purchase.payToAddress as `0x${string}`,
        amountAtomic: purchase.expectedAmountAtomic,
        authorizationTtlSeconds: config.ERC3009_AUTH_TTL_SECONDS,
        maximumValidBefore: maximumAuthorizationValidBefore(expiresAt),
        expectedFacilitatorUrl: config.X402_FACILITATOR_URL,
        onLivePaymentTerms: async (livePaymentTerms) => {
          await this.registry.assertPurchase(purchase.id, config.SERVICE_DISCOVERY_MODE === "bazaar");
          const decision = evaluateRetryLiveTerms(livePaymentTerms);
          if (decision.approved) return;
          await persistRetryLiveTermsRejection(livePaymentTerms, decision);
          throw new MelloError(
            "POLICY_REJECTED",
            `Live 402 retry terms rejected: ${decision.reasonCodes.join(", ")}`,
            { statusCode: 409, details: { reasonCodes: decision.reasonCodes } },
          );
        },
      });
    } catch (error: unknown) {
      if (rejectedBeforeSigning) return;
      throw error;
    }
    const retryLivePolicyDecision = evaluateRetryLiveTerms(prepared.validatedTerms);
    if (!retryLivePolicyDecision.approved) {
      prepared.cancel("Live 402 retry terms failed enterprise policy");
      await persistRetryLiveTermsRejection(
        prepared.validatedTerms,
        retryLivePolicyDecision,
      );
      return;
    }
    if (
      purchase.authorization?.nonce.toLowerCase() ===
      prepared.authorization.nonce.toLowerCase()
    ) {
      prepared.cancel("Retry returned a previously used ERC-3009 nonce");
      throw new MelloError("ERC3009_NONCE_REUSED", "Authorization retry must use a new nonce");
    }
    if (prepared.authorization.validBefore <= BigInt(Math.floor(now.getTime() / 1_000))) {
      prepared.cancel("Retry returned an expired ERC-3009 authorization");
      throw new MelloError("ERC3009_AUTH_EXPIRED", "Authorization retry is already expired");
    }

    await this.persistPreparedAuthorization({
      taskId: purchase.taskId,
      purchaseId: purchase.id,
      paymentId: purchase.paymentId,
      sellerId,
      buyerAddress: purchase.buyerAddress,
      payToAddress: purchase.payToAddress,
      amountAtomic: purchase.expectedAmountAtomic,
      network: purchase.network,
      tokenAddress: purchase.tokenAddress,
      prepared,
      requestId,
      retry: true,
      refreshedMandate: { expiresAt, mandateHash },
    });

    const authorizationAnchorConfirmed = await this.authorizeAnchor(
      {
        ...anchorInput,
        expiresAt,
        mandateHash,
        paymentAuthorizationHash: prepared.authorizationHash,
      },
      requestId,
    );
    if (!authorizationAnchorConfirmed && !config.DEMO_ALLOW_OFFCHAIN_AUTH) {
      prepared.cancel("Authorization anchor was not confirmed");
      await this.markActionRequired(
        purchase.taskId,
        purchase.id,
        "CONTRACT_ANCHOR_FAILED",
        "Fresh authorization anchor failed before payment; no payment was submitted.",
        requestId,
      );
      return;
    }
    if (!authorizationAnchorConfirmed) {
      await this.appendPaymentLifecycleEvent({
        taskId: purchase.taskId,
        purchaseId: purchase.id,
        paymentId: purchase.paymentId,
        sellerId,
        requestId,
        stage: "AUTH_ANCHOR_PENDING",
        eventType: "AUTHORIZATION_ANCHOR_FALLBACK_USED",
        payload: {
          displayStatus: "AUTH_ANCHOR_PENDING",
          paymentMayContinue: true,
          anchorConfirmed: false,
          retryRequired: true,
          retry: true,
        },
      });
    }
    await this.submitPreparedPaymentAndContinue({
      taskId: purchase.taskId,
      purchaseId: purchase.id,
      paymentId: purchase.paymentId,
      sellerId,
      prepared,
      authorizationAnchorConfirmed,
      requestId,
    });
  }

  private async completeAfterRecoveredAuthorization(
    purchase: {
      id: string;
      taskId: string;
      paymentId: string;
      expectedAmountAtomic: string;
      actualAmountAtomic: string | null;
      anchors: { kind: string; status: string }[];
      service: { sellerId: string };
      payment: { status: string; transactionHash: string | null } | null;
      delivery: { status: string; responseHash: string | null } | null;
      invoice: { status: string; canonicalHash: string | null } | null;
      reconciliation: { status: string; canonicalHash: string | null } | null;
    },
    requestId?: string,
  ): Promise<void> {
    const finalizeAnchor = purchase.anchors.find((anchor) => anchor.kind === "FINALIZE");
    if (
      purchase.payment?.status !== "SETTLED" ||
      !purchase.payment.transactionHash ||
      purchase.delivery?.status !== "DELIVERED" ||
      !purchase.delivery.responseHash ||
      !purchase.invoice?.canonicalHash ||
      purchase.reconciliation?.status !== "MATCHED" ||
      !purchase.reconciliation.canonicalHash
    ) {
      return;
    }
    const finalConfirmed =
      finalizeAnchor?.status === "CONFIRMED" ||
      (await this.finalizeAnchor(
        {
          id: purchase.id,
          actualAmountAtomic: purchase.actualAmountAtomic ?? purchase.expectedAmountAtomic,
          settlementTxHash: purchase.payment.transactionHash,
          receiptHash: purchase.delivery.responseHash,
          invoiceHash: purchase.invoice.canonicalHash,
          reconciliationHash: purchase.reconciliation.canonicalHash,
        },
        requestId,
      ));
    if (finalConfirmed) {
      await this.markCompleted(
        purchase.id,
        purchase.taskId,
        purchase.paymentId,
        purchase.service.sellerId,
        purchase.invoice.status,
        requestId,
      );
    }
  }

  private async markAuthorizationSignatureUnavailable(
    taskId: string,
    purchaseId: string,
    requestId?: string,
  ): Promise<void> {
    await this.markActionRequired(
      taskId,
      purchaseId,
      "CONTRACT_ANCHOR_FAILED",
      "The authorization anchor is confirmed, but the ephemeral payment signature is no longer available. The immutable on-chain authorization cannot be replaced safely; payment was not resubmitted.",
      requestId,
      "AUTHORIZATION_SIGNATURE_UNAVAILABLE",
    );
  }

  private async appendPaymentLifecycleEvent(input: {
    taskId: string;
    purchaseId: string;
    paymentId: string;
    sellerId: string;
    requestId: string | undefined;
    eventType: string;
    stage: string;
    payload: unknown;
  }): Promise<void> {
    await this.dependencies.prisma.$transaction(async (transaction) => {
      await appendAuditEvent(transaction, {
        aggregateType: "PAYMENT",
        aggregateId: input.paymentId,
        taskId: input.taskId,
        purchaseId: input.purchaseId,
        paymentId: input.paymentId,
        sellerId: input.sellerId,
        requestId: input.requestId,
        stage: input.stage,
        eventType: input.eventType,
        payload: input.payload,
      });
    });
  }

  private async recordPaidRequestReleased(input: {
    taskId: string;
    purchaseId: string;
    paymentId: string;
    sellerId: string;
    requestId: string | undefined;
    mode: PaymentProvider["mode"];
  }): Promise<void> {
    await this.dependencies.prisma.$transaction(async (transaction) => {
      const authorizationTransition = await transaction.paymentAuthorization.updateMany({
        where: {
          purchaseId: input.purchaseId,
          paymentId: input.paymentId,
          status: { in: ["CREATED", "SIGNED"] },
        },
        data: { status: "SUBMITTED" },
      });
      if (authorizationTransition.count !== 1) {
        throw new MelloError(
          "INTERNAL_ERROR",
          "Authorization state changed as the paid request was released",
          { statusCode: 409, retryable: true },
        );
      }
      await appendAuditEvent(transaction, {
        aggregateType: "PAYMENT",
        aggregateId: input.paymentId,
        taskId: input.taskId,
        purchaseId: input.purchaseId,
        paymentId: input.paymentId,
        sellerId: input.sellerId,
        requestId: input.requestId,
        stage: "PAYING",
        eventType: "SUBMITTED_TO_SELLER",
        payload: {
          mode: input.mode,
          boundary: "SIGNED_PAID_REQUEST_RELEASED",
          paidRequestReleased: true,
          simulated: input.mode === "mock",
        },
      });
      await appendAuditEvent(transaction, {
        aggregateType: "PAYMENT",
        aggregateId: input.paymentId,
        taskId: input.taskId,
        purchaseId: input.purchaseId,
        paymentId: input.paymentId,
        sellerId: input.sellerId,
        requestId: input.requestId,
        stage: "PAYING",
        eventType: "SIGNED_PAID_REQUEST_RELEASED",
        payload: {
          mode: input.mode,
          boundary: "SIGNED_PAID_REQUEST_RELEASED",
          paidRequestReleased: true,
        },
      });
    });
  }

  private async appendVerifiedFacilitatorLifecycle(
    transaction: Prisma.TransactionClient,
    input: {
      taskId: string;
      purchaseId: string;
      paymentId: string;
      sellerId: string;
      requestId?: string | undefined;
      transactionHash: string;
      verifiedChainId?: number | undefined;
      recovered: boolean;
    },
  ): Promise<void> {
    if (this.dependencies.paymentProvider.mode !== "x402") return;
    const payload = {
      transactionHash: input.transactionHash,
      verifiedChainId: input.verifiedChainId ?? null,
      receiptIndependentlyVerified: true,
      recovered: input.recovered,
      observation: "RETROSPECTIVE_FROM_X402_SUCCESS_AND_VERIFIED_RECEIPT",
    };
    for (const eventType of ["FACILITATOR_VERIFYING", "FACILITATOR_SETTLING"] as const) {
      await appendAuditEvent(transaction, {
        aggregateType: "PAYMENT",
        aggregateId: input.paymentId,
        taskId: input.taskId,
        purchaseId: input.purchaseId,
        paymentId: input.paymentId,
        sellerId: input.sellerId,
        requestId: input.requestId,
        stage: eventType,
        eventType,
        payload,
      });
    }
  }

  private async recordPendingSettlementReconciliation(input: {
    taskId: string;
    purchaseId: string;
    paymentId: string;
    sellerId: string;
    error: unknown;
    paidRequestReleased: boolean;
    authorizationStatus: string;
    requestId: string | undefined;
  }): Promise<void> {
    const errorCode =
      input.error instanceof MelloError ? input.error.code : "X402_PAYMENT_FAILED";
    const cause = sanitizedErrorMessage(
      input.error,
      "Payment provider returned an unknown error",
    );
    const message = input.paidRequestReleased
      ? `Payment submission outcome is unknown; automatic resubmission is prohibited. ${cause}`
      : `Payment submission stopped before the paid request was released. ${cause}`;
    const pendingEvidence =
      input.error instanceof PendingSettlementVerificationError
        ? input.error.evidence
        : null;
    await this.dependencies.prisma.$transaction(async (transaction) => {
      const existingReconciliation = await transaction.reconciliation.findUnique({
        where: { purchaseId: input.purchaseId },
        select: { status: true },
      });
      if (!existingReconciliation) {
        throw new MelloError("INTERNAL_ERROR", "Purchase reconciliation record is missing", {
          statusCode: 409,
        });
      }
      if (input.paidRequestReleased) {
        const authorizationTransition = await transaction.paymentAuthorization.updateMany({
          where: {
            purchaseId: input.purchaseId,
            paymentId: input.paymentId,
            status: { in: ["CREATED", "SIGNED", "SUBMITTED"] },
          },
          data: { status: "SUBMITTED" },
        });
        if (authorizationTransition.count !== 1) {
          throw new MelloError(
            "INTERNAL_ERROR",
            "Authorization state changed while preserving an ambiguous submission",
            { statusCode: 409, retryable: true },
          );
        }
      } else {
        const paymentTransition = await transaction.payment.updateMany({
          where: { purchaseId: input.purchaseId, status: "SETTLEMENT_PENDING" },
          data: { status: "FAILED" },
        });
        if (paymentTransition.count !== 1) {
          throw new MelloError(
            "INTERNAL_ERROR",
            "Payment state changed while recording a pre-release abort",
            { statusCode: 409, retryable: true },
          );
        }
        const authorizationTerminalStatus =
          errorCode === "ERC3009_AUTH_EXPIRED" ? "EXPIRED" : "REJECTED";
        const authorizationTransition = await transaction.paymentAuthorization.updateMany({
          where: {
            purchaseId: input.purchaseId,
            paymentId: input.paymentId,
            status: { in: ["CREATED", "SIGNED"] },
          },
          data: { status: authorizationTerminalStatus },
        });
        if (authorizationTransition.count !== 1) {
          throw new MelloError(
            "INTERNAL_ERROR",
            "Authorization state changed while recording a pre-release abort",
            { statusCode: 409, retryable: true },
          );
        }
        await appendAuditEvent(transaction, {
          aggregateType: "PAYMENT",
          aggregateId: input.paymentId,
          taskId: input.taskId,
          purchaseId: input.purchaseId,
          paymentId: input.paymentId,
          sellerId: input.sellerId,
          requestId: input.requestId,
          stage: "PAYING",
          eventType:
            authorizationTerminalStatus === "EXPIRED"
              ? "AUTHORIZATION_EXPIRED"
              : "AUTHORIZATION_REJECTED",
          payload: {
            errorCode,
            previousStatus: input.authorizationStatus,
            status: authorizationTerminalStatus,
            paidRequestReleased: false,
          },
        });
      }
      if (pendingEvidence) {
        const paymentTransition = await transaction.payment.updateMany({
          where: { purchaseId: input.purchaseId, status: "SETTLEMENT_PENDING" },
          data: {
            status: "SETTLEMENT_PENDING",
            transactionHash: pendingEvidence.transactionHash,
            paymentResponse: jsonValue(pendingEvidence.paymentResponse),
            payerAddress: pendingEvidence.payerAddress,
            payeeAddress: pendingEvidence.payeeAddress,
            amountAtomic: pendingEvidence.amountAtomic,
            network: pendingEvidence.network,
            tokenAddress: pendingEvidence.tokenAddress,
          },
        });
        if (paymentTransition.count !== 1) {
          throw new MelloError(
            "INTERNAL_ERROR",
            "Payment state changed while preserving pending settlement evidence",
            { statusCode: 409, retryable: true },
          );
        }
        if (pendingEvidence.report) {
          const deliveryTransition = await transaction.delivery.updateMany({
            where: { purchaseId: input.purchaseId, status: "PENDING" },
            data: {
              status: "PENDING",
              responseBody: jsonValue(pendingEvidence.report),
              responseHash: null,
              deliveredAt: null,
            },
          });
          if (deliveryTransition.count !== 1) {
            throw new MelloError(
              "INTERNAL_ERROR",
              "Delivery state changed while quarantining an unverified report",
              { statusCode: 409, retryable: true },
            );
          }
        }
      }
      if (existingReconciliation.status !== "MISMATCH") {
        const reconciliationTransition = await transaction.reconciliation.updateMany({
          where: { purchaseId: input.purchaseId, status: existingReconciliation?.status },
          data: { status: "PENDING", reconciledAt: null },
        });
        if (reconciliationTransition.count !== 1) {
          throw new MelloError(
            "INTERNAL_ERROR",
            "Reconciliation state changed while preserving a submission outcome",
            { statusCode: 409, retryable: true },
          );
        }
      }
      await transitionPurchaseWorkflowStage(transaction, {
        taskId: input.taskId,
        purchaseId: input.purchaseId,
        expectedTaskStatuses: ["PAYING", "ACTION_REQUIRED"],
        expectedPurchaseStatuses: ["PAYING", "ACTION_REQUIRED"],
        nextTaskStatus: input.paidRequestReleased ? "ACTION_REQUIRED" : "FAILED",
        nextPurchaseStatus: input.paidRequestReleased ? "ACTION_REQUIRED" : "FAILED",
        taskData: {
          errorCode,
          errorMessage: message,
        },
        aggregateType: "PAYMENT",
        aggregateId: input.paymentId,
        paymentId: input.paymentId,
        sellerId: input.sellerId,
        requestId: input.requestId,
        stage: input.paidRequestReleased ? "PENDING_RECONCILIATION" : "FAILED",
        eventType: input.paidRequestReleased
          ? "PENDING_RECONCILIATION"
          : "PAYMENT_SUBMISSION_ABORTED_BEFORE_RELEASE",
        payload: {
          errorCode,
          settlementOutcome: input.paidRequestReleased ? "UNKNOWN" : "NOT_SUBMITTED",
          paymentStatus: input.paidRequestReleased ? "SETTLEMENT_PENDING" : "FAILED",
          authorizationStatus: input.paidRequestReleased
            ? "SUBMITTED"
            : errorCode === "ERC3009_AUTH_EXPIRED"
              ? "EXPIRED"
              : "REJECTED",
          automaticResubmissionAllowed: false,
          candidateTransactionHash: pendingEvidence?.transactionHash ?? null,
          receiptIndependentlyVerified: false,
          reportQuarantined: pendingEvidence?.report !== undefined,
          reconciliationStatus:
            existingReconciliation.status === "MISMATCH" ? "MISMATCH" : "PENDING",
          mismatchReportPreserved: existingReconciliation.status === "MISMATCH",
        },
      });
    });
    if (!input.paidRequestReleased) {
      await this.anchorConclusiveTerminalFailure(
        input.purchaseId,
        errorCode,
        input.requestId,
      );
    }
  }

  private async recordSettledDeliveryFailure(input: {
    taskId: string;
    purchaseId: string;
    sellerId: string;
    error: SettledPaymentDeliveryError;
    requestId?: string;
  }): Promise<void> {
    const { prisma } = this.dependencies;
    const { settlement } = input.error;
    await prisma.$transaction(async (transaction) => {
      const paymentTransition = await transaction.payment.updateMany({
        where: { purchaseId: input.purchaseId, status: "SETTLEMENT_PENDING" },
        data: {
          status: "SETTLED",
          transactionHash: settlement.transactionHash,
          paymentResponse: jsonValue(settlement.paymentResponse),
          payerAddress: settlement.payerAddress,
          payeeAddress: settlement.payeeAddress,
          amountAtomic: settlement.amountAtomic,
          network: settlement.network,
          tokenAddress: settlement.tokenAddress,
          settledAt: this.now(),
        },
      });
      const authorizationTransition = await transaction.paymentAuthorization.updateMany({
        where: {
          purchaseId: input.purchaseId,
          status: { in: ["CREATED", "SIGNED", "SUBMITTED"] },
        },
        data: {
          status: "SETTLED",
          settlementTxHash: settlement.transactionHash,
        },
      });
      const deliveryTransition = await transaction.delivery.updateMany({
        where: { purchaseId: input.purchaseId, status: "PENDING" },
        data: { status: "FAILED" },
      });
      if (
        paymentTransition.count !== 1 ||
        authorizationTransition.count !== 1 ||
        deliveryTransition.count !== 1
      ) {
        throw new MelloError("INTERNAL_ERROR", "Settled delivery state changed before commit", {
          statusCode: 409,
          retryable: true,
        });
      }
      await this.appendVerifiedFacilitatorLifecycle(transaction, {
        taskId: input.taskId,
        purchaseId: input.purchaseId,
        paymentId: settlement.paymentId,
        sellerId: input.sellerId,
        requestId: input.requestId,
        transactionHash: settlement.transactionHash,
        verifiedChainId: settlement.verifiedChainId,
        recovered: false,
      });
      await transitionPurchaseWorkflowStage(transaction, {
        taskId: input.taskId,
        purchaseId: input.purchaseId,
        expectedTaskStatuses: ["PAYING"],
        expectedPurchaseStatuses: ["PAYING"],
        nextTaskStatus: "ACTION_REQUIRED",
        nextPurchaseStatus: "ACTION_REQUIRED",
        taskData: {
          errorCode: input.error.code,
          errorMessage: sanitizedErrorMessage(
            input.error,
            "Seller delivery could not be validated after settlement",
          ),
        },
        purchaseData: {
          actualAmountAtomic: settlement.amountAtomic,
          paymentExplorerBase: paymentExplorerBaseForVerifiedSettlement(
            this.dependencies.config,
            settlement,
          ),
        },
        aggregateType: "PURCHASE",
        aggregateId: input.purchaseId,
        paymentId: settlement.paymentId,
        sellerId: input.sellerId,
        requestId: input.requestId,
        stage: "DELIVERING",
        eventType: "PAYMENT_SETTLED_DELIVERY_FAILED",
        payload: {
          errorCode: input.error.code,
          transactionHash: settlement.transactionHash,
          amountAtomic: settlement.amountAtomic,
          verifiedChainId: settlement.verifiedChainId ?? null,
          paymentRemainsSettled: true,
        },
      });
    });
  }

  private async issueInvoiceAndComplete(purchaseId: string, requestId?: string): Promise<void> {
    const { prisma, invoiceAdapter, config } = this.dependencies;
    const purchase = await prisma.purchase.findUniqueOrThrow({
      where: { id: purchaseId },
      include: {
        task: true,
        service: { include: { seller: true } },
        buyerProfile: true,
        payment: true,
        delivery: true,
        invoice: true,
        reconciliation: true,
        authorization: {
          select: {
            paymentId: true,
            amountAtomic: true,
            toAddress: true,
            fromAddress: true,
            network: true,
            tokenAddress: true,
            status: true,
            settlementTxHash: true,
          },
        },
      },
    });
    if (!purchase.payment || !purchase.delivery || !purchase.invoice || !purchase.reconciliation) {
      throw new Error("Purchase financial records are incomplete");
    }
    const policySnapshot = PolicyInputSchema.parse(purchase.policySnapshot);
    const intent = purchase.task.intent as {
      requiresTwInvoice?: boolean;
      buyerBusinessId?: string;
      targetCompanyName?: string;
    } | null;
    const invoiceRequired = policySnapshot.requireTwInvoice || intent?.requiresTwInvoice === true;
    const buyerProfile = purchase.buyerProfileSnapshot
      ? InvoiceBuyerProfileSchema.parse(purchase.buyerProfileSnapshot)
      : undefined;
    const originalBusinessId = buyerProfile?.businessId ?? intent?.buyerBusinessId ?? purchase.buyerProfile.businessId;
    const enteringReconciliation =
      purchase.task.status === "INVOICING" && purchase.status === "INVOICING";
    const resumingReconciliation =
      purchase.task.status === "RECONCILING" && purchase.status === "RECONCILING";
    if (!enteringReconciliation && !resumingReconciliation) {
      throw new MelloError("INTERNAL_ERROR", "Purchase is not ready for invoice completion", {
        statusCode: 409,
        retryable: true,
      });
    }

    if (
      invoiceRequired &&
      (purchase.invoice.status === "PENDING" || purchase.invoice.status === "FAILED_RETRYABLE")
    ) {
      const buyerBusinessId = intent?.buyerBusinessId ?? "";
      const sellerBusinessId = purchase.service.seller.businessId ?? "";
      const issueInput = {
        purchaseId,
        buyerBusinessId,
        ...(buyerProfile ? { buyerProfile } : {}),
        sellerBusinessId,
        sellerProfileId: purchase.service.seller.id,
        sourceAmountAtomic: purchase.payment.amountAtomic ?? "",
        fxRateTwdPerUsdc: config.DEMO_TWD_PER_USDC,
        itemName: `${intent?.targetCompanyName ?? "Example Co."} 信用報告`,
        paymentId: purchase.paymentId,
        paymentTxHash: purchase.payment.transactionHash ?? "",
        issuedAt: this.now(),
      };
      let safeIssue: Awaited<ReturnType<typeof issueInvoiceSafely>>;
      try {
        safeIssue = await issueInvoiceSafely({
          adapter: invoiceAdapter,
          timeoutMs: this.invoiceTimeoutMs,
          issue: issueInput,
          preflight: {
            invoiceStatus: purchase.invoice.status,
            paymentStatus: purchase.payment.status,
            deliveryStatus: purchase.delivery.status,
            deliveryResponseHash: purchase.delivery.responseHash,
            settlementTransactionHash: purchase.payment.transactionHash,
            quotedAmountAtomic: purchase.expectedAmountAtomic,
            registryQuoteAmountAtomic: purchase.service.priceAtomic,
            actualAmountAtomic: purchase.actualAmountAtomic,
            settledAmountAtomic: purchase.payment.amountAtomic,
            buyerAddress: purchase.buyerAddress,
            payerAddress: purchase.payment.payerAddress,
            purchasePayeeAddress: purchase.payToAddress,
            registryPayeeAddress: purchase.service.seller.payToAddress,
            settledPayeeAddress: purchase.payment.payeeAddress,
            purchaseNetwork: purchase.network,
            registryNetwork: purchase.service.network,
            settledNetwork: purchase.payment.network,
            purchaseTokenAddress: purchase.tokenAddress,
            registryTokenAddress: purchase.service.tokenAddress,
            settledTokenAddress: purchase.payment.tokenAddress,
            purchaseTokenSymbol: purchase.tokenSymbol,
            registryTokenSymbol: purchase.service.tokenSymbol,
            purchaseTokenDecimals: purchase.tokenDecimals,
            registryTokenDecimals: purchase.service.tokenDecimals,
            purchasePaymentId: purchase.paymentId,
            authorizationPaymentId: purchase.authorization?.paymentId ?? null,
            serviceSupportsTwInvoice: purchase.service.supportsTwInvoice,
            sellerInvoiceCapability: purchase.service.seller.invoiceCapability,
            sellerInvoiceProvider: purchase.service.seller.invoiceProvider,
            buyerBusinessId,
            companyBusinessId: originalBusinessId,
            sellerBusinessId: purchase.service.seller.businessId,
          },
        });
      } catch (error: unknown) {
        const retryable = error instanceof RetryableInvoiceError;
        await prisma.$transaction(async (transaction) => {
          const invoiceTransition = await transaction.invoice.updateMany({
            where: {
              id: purchase.invoice!.id,
              status: purchase.invoice!.status,
              attemptCount: purchase.invoice!.attemptCount,
            },
            data: {
              status: retryable ? "FAILED_RETRYABLE" : "FAILED_FINAL",
              attemptCount: { increment: 1 },
              lastError: sanitizedErrorMessage(
                error,
                "Invoice provider returned an unknown error",
              ),
            },
          });
          if (invoiceTransition.count !== 1) {
            throw new MelloError("INVOICE_ISSUE_FAILED", "Invoice state changed after failure", {
              statusCode: 409,
            });
          }
          await transitionPurchaseWorkflowStage(transaction, {
            taskId: purchase.taskId,
            purchaseId,
            expectedTaskStatuses: ["INVOICING"],
            expectedPurchaseStatuses: ["INVOICING"],
            nextTaskStatus: "ACTION_REQUIRED",
            nextPurchaseStatus: "ACTION_REQUIRED",
            taskData: {
              errorCode: "INVOICE_ISSUE_FAILED",
              errorMessage: sanitizedErrorMessage(
                error,
                "Invoice provider returned an unknown error",
              ),
            },
            aggregateType: "INVOICE",
            aggregateId: purchase.invoice!.id,
            paymentId: purchase.paymentId,
            sellerId: purchase.service.sellerId,
            requestId,
            stage: "INVOICING",
            eventType: retryable ? "INVOICE_FAILED_RETRYABLE" : "INVOICE_FAILED_FINAL",
            payload: { retryable, paymentRemainsSettled: true },
          });
        });
        return;
      }
      if (safeIssue.kind === "PRECONDITION_FAILED") {
        const errorMessage = `Invoice preflight failed: ${safeIssue.preflight.failedCheckIds.join(", ")}`;
        await prisma.$transaction(async (transaction) => {
          const reconciliationTransition = await transaction.reconciliation.updateMany({
            where: { purchaseId, status: purchase.reconciliation!.status },
            data: {
              status: "MISMATCH",
              checks: jsonValue(safeIssue.preflight.checks),
              canonicalHash: safeIssue.preflight.canonicalHash,
              reconciledAt: null,
            },
          });
          if (reconciliationTransition.count !== 1) {
            throw new MelloError(
              "RECONCILIATION_MISMATCH",
              "Reconciliation state changed during invoice preflight",
              { statusCode: 409 },
            );
          }
          await transitionPurchaseWorkflowStage(transaction, {
            taskId: purchase.taskId,
            purchaseId,
            expectedTaskStatuses: ["INVOICING"],
            expectedPurchaseStatuses: ["INVOICING"],
            nextTaskStatus: "ACTION_REQUIRED",
            nextPurchaseStatus: "ACTION_REQUIRED",
            taskData: {
              errorCode: "RECONCILIATION_MISMATCH",
              errorMessage,
            },
            aggregateType: "INVOICE",
            aggregateId: purchase.invoice!.id,
            paymentId: purchase.paymentId,
            sellerId: purchase.service.sellerId,
            requestId,
            stage: "INVOICING",
            eventType: "INVOICE_PREFLIGHT_REJECTED",
            payload: {
              failedCheckIds: safeIssue.preflight.failedCheckIds,
              preflightHash: safeIssue.preflight.canonicalHash,
              adapterCalled: false,
            },
          });
        });
        return;
      }
      if (safeIssue.kind === "ISSUED") {
        await persistIssuedInvoice(prisma, {
          invoiceId: purchase.invoice.id,
          invoice: safeIssue.invoice,
          taskId: purchase.taskId,
          purchaseId,
          paymentId: purchase.paymentId,
          sellerId: purchase.service.sellerId,
          requestId,
        });
      }
    }

    const currentInvoice = await prisma.invoice.findUniqueOrThrow({ where: { purchaseId } });
    if (enteringReconciliation) {
      await prisma.$transaction(async (transaction) => {
        await transitionPurchaseWorkflowStage(transaction, {
          taskId: purchase.taskId,
          purchaseId,
          expectedTaskStatuses: ["INVOICING"],
          expectedPurchaseStatuses: ["INVOICING"],
          nextTaskStatus: "RECONCILING",
          nextPurchaseStatus: "RECONCILING",
          aggregateType: "PURCHASE",
          aggregateId: purchaseId,
          paymentId: purchase.paymentId,
          sellerId: purchase.service.sellerId,
          requestId,
          stage: "RECONCILING",
          eventType: "RECONCILIATION_STARTED",
          payload: {
            previousStatus: "INVOICING",
            invoiceStatus: currentInvoice.status,
          },
        });
      });
    }
    const reconciliation = reconcilePurchase({
      service: {
        amountAtomic: purchase.service.priceAtomic,
        payee: purchase.service.seller.payToAddress,
        network: purchase.service.network,
        token: {
          symbol: purchase.service.tokenSymbol,
          address: purchase.service.tokenAddress,
          decimals: purchase.service.tokenDecimals,
        },
        sellerProfileId: purchase.service.sellerId,
        sellerBusinessId: purchase.service.seller.businessId,
      },
      purchase: {
        expectedAmountAtomic: purchase.expectedAmountAtomic,
        actualAmountAtomic: purchase.actualAmountAtomic,
        payee: purchase.payToAddress,
        payer: purchase.buyerAddress,
        network: purchase.network,
        token: {
          symbol: purchase.tokenSymbol,
          address: purchase.tokenAddress,
          decimals: purchase.tokenDecimals,
        },
        paymentId: purchase.paymentId,
      },
      authorization: purchase.authorization
        ? {
            paymentId: purchase.authorization.paymentId,
            amountAtomic: purchase.authorization.amountAtomic,
            payee: purchase.authorization.toAddress,
            payer: purchase.authorization.fromAddress,
            network: purchase.authorization.network,
            tokenAddress: purchase.authorization.tokenAddress,
            status: purchase.authorization.status,
            settlementTransactionHash: purchase.authorization.settlementTxHash,
          }
        : null,
      payment: {
        paymentId: purchase.payment.paymentId,
        status: purchase.payment.status,
        transactionHash: purchase.payment.transactionHash,
        amountAtomic: purchase.payment.amountAtomic ?? "",
        payee: purchase.payment.payeeAddress ?? "",
        payer: purchase.payment.payerAddress ?? "",
        network: purchase.payment.network ?? "",
        tokenAddress: purchase.payment.tokenAddress ?? "",
      },
      invoiceRequired,
      invoice: invoiceRequired
        ? {
            sourceAmountAtomic: currentInvoice.sourceAmountAtomic ?? "",
            buyerBusinessId: currentInvoice.buyerBusinessId ?? "",
            sellerBusinessId: currentInvoice.sellerBusinessId ?? "",
            sellerProfileId: currentInvoice.sellerProfileId ?? "",
            paymentId: currentInvoice.paymentId ?? "",
            paymentTransactionHash: currentInvoice.paymentTxHash ?? "",
          }
        : null,
      companyBusinessId: originalBusinessId,
      deliveryResponseHash: purchase.delivery.responseHash,
    });
    await prisma.$transaction(async (transaction) => {
      const reconciliationTransition = await transaction.reconciliation.updateMany({
        where: { purchaseId, status: "PENDING" },
        data: {
          status: reconciliation.status,
          checks: jsonValue(reconciliation.checks),
          canonicalHash: reconciliation.canonicalHash,
          reconciledAt: reconciliation.status === "MATCHED" ? this.now() : null,
        },
      });
      if (reconciliationTransition.count !== 1) {
        throw new MelloError("INTERNAL_ERROR", "Reconciliation state changed before commit", {
          statusCode: 409,
          retryable: true,
        });
      }
      await transitionPurchaseWorkflowStage(transaction, {
        taskId: purchase.taskId,
        purchaseId,
        expectedTaskStatuses: ["RECONCILING"],
        expectedPurchaseStatuses: ["RECONCILING"],
        nextTaskStatus:
          reconciliation.status === "MATCHED" ? "FINAL_ANCHOR_PENDING" : "ACTION_REQUIRED",
        nextPurchaseStatus:
          reconciliation.status === "MATCHED" ? "FINAL_ANCHOR_PENDING" : "ACTION_REQUIRED",
        taskData: {
          errorCode: reconciliation.status === "MATCHED" ? null : "RECONCILIATION_MISMATCH",
        },
        aggregateType: "PURCHASE",
        aggregateId: purchaseId,
        paymentId: purchase.paymentId,
        sellerId: purchase.service.sellerId,
        requestId,
        stage: "RECONCILING",
        eventType:
          reconciliation.status === "MATCHED"
            ? "RECONCILIATION_MATCHED"
            : "RECONCILIATION_MISMATCH",
        payload: reconciliation,
      });
    });
    if (reconciliation.status !== "MATCHED") return;

    const invoiceHash = currentInvoice.canonicalHash;
    if (
      !purchase.payment.transactionHash ||
      !purchase.delivery.responseHash ||
      !invoiceHash
    ) {
      throw new Error("Final anchor evidence is incomplete");
    }
    const finalAnchorConfirmed = await this.finalizeAnchor(
      {
        id: purchaseId,
        actualAmountAtomic: purchase.payment.amountAtomic ?? purchase.expectedAmountAtomic,
        settlementTxHash: purchase.payment.transactionHash,
        receiptHash: purchase.delivery.responseHash,
        invoiceHash,
        reconciliationHash: reconciliation.canonicalHash,
      },
      requestId,
    );
    if (!finalAnchorConfirmed) return;
    await this.markCompleted(
      purchaseId,
      purchase.taskId,
      purchase.paymentId,
      purchase.service.sellerId,
      currentInvoice.status,
      requestId,
    );
  }

  private async markCompleted(
    purchaseId: string,
    taskId: string,
    paymentId: string,
    sellerId: string,
    invoiceStatus: string,
    requestId?: string,
  ): Promise<void> {
    await this.dependencies.prisma.$transaction(async (transaction) => {
      const [task, purchase] = await Promise.all([
        transaction.task.findUnique({ where: { id: taskId }, select: { status: true } }),
        transaction.purchase.findUnique({
          where: { id: purchaseId },
          select: { status: true, taskId: true },
        }),
      ]);
      if (task?.status === "COMPLETED" && purchase?.status === "COMPLETED") return;
      await transitionPurchaseWorkflowStage(transaction, {
        taskId,
        purchaseId,
        expectedTaskStatuses: ["FINAL_ANCHOR_PENDING", "ACTION_REQUIRED"],
        expectedPurchaseStatuses: ["FINAL_ANCHOR_PENDING", "ACTION_REQUIRED"],
        nextTaskStatus: "COMPLETED",
        nextPurchaseStatus: "COMPLETED",
        taskData: {
          completedAt: this.now(),
          errorCode: null,
          errorMessage: null,
        },
        aggregateType: "PURCHASE",
        aggregateId: purchaseId,
        paymentId,
        sellerId,
        requestId,
        stage: "COMPLETED",
        eventType: "PURCHASE_COMPLETED",
        payload: {
          paymentStatus: "SETTLED",
          deliveryStatus: "DELIVERED",
          invoiceStatus,
          reconciliationStatus: "MATCHED",
        },
      });
    });
  }

  private async authorizeAnchor(
    input: AuthorizationAnchorInput,
    requestId?: string,
  ): Promise<boolean> {
    const { prisma, anchorClient, config } = this.dependencies;
    const existing = await beginAnchorAttempt(prisma, {
      purchaseId: input.id,
      kind: "AUTHORIZE",
      contractAddress: config.AUDIT_REGISTRY_ADDRESS ?? null,
      requestId,
    });
    if (anchorClient.mode === "disabled") {
      await this.anchorFailed(input.id, "AUTHORIZE", new Error("Anchoring disabled"), requestId);
      return false;
    }
    try {
      let result: AnchorTransactionResult;
      let reconciled = false;
      if (existing?.transactionHash) {
        reconciled = true;
        result = await anchorClient.reconcileTransaction(
          existing.transactionHash as `0x${string}`,
        );
      } else {
        const chainState = await anchorClient.getPurchaseState(input.id);
        if (chainState.status !== "NONE") {
          throw new Error(
            chainState.status === "AUTHORIZED" &&
              chainState.paymentAuthorizationHash.toLowerCase() ===
                input.paymentAuthorizationHash.toLowerCase()
              ? "Authorization is already on-chain, but its transaction hash is unavailable"
              : `Cannot authorize an immutable on-chain purchase in ${chainState.status} state`,
          );
        }
        result = await anchorClient.authorizePurchase(
          {
            purchaseId: input.id,
            buyer: input.buyerAddress as `0x${string}`,
            seller: input.payToAddress as `0x${string}`,
            token: input.tokenAddress as `0x${string}`,
            maxAmount: BigInt(input.maxAmountAtomic),
            expiresAt: BigInt(Math.floor(input.expiresAt.getTime() / 1_000)),
            mandateHash: input.mandateHash as `0x${string}`,
            policyHash: input.policyHash as `0x${string}`,
            paymentAuthorizationHash: input.paymentAuthorizationHash as `0x${string}`,
          },
          {
            onSubmitted: (transactionHash) =>
              this.recordAnchorSubmitted(
                input.id,
                "AUTHORIZE",
                transactionHash,
                requestId,
              ),
          },
        );
      }
      await this.confirmAnchor(input.id, "AUTHORIZE", result, requestId, reconciled);
      return true;
    } catch (error: unknown) {
      await this.recoverSubmittedHash(input.id, "AUTHORIZE", error, requestId);
      await this.anchorFailed(input.id, "AUTHORIZE", error, requestId, {
        clearSubmission: error instanceof AnchorTransactionRevertedError,
      });
      return false;
    }
  }

  private async finalizeAnchor(
    input: FinalizationAnchorInput,
    requestId?: string,
  ): Promise<boolean> {
    const { prisma, anchorClient, config } = this.dependencies;
    const existing = await beginAnchorAttempt(prisma, {
      purchaseId: input.id,
      kind: "FINALIZE",
      contractAddress: config.AUDIT_REGISTRY_ADDRESS ?? null,
      requestId,
    });
    if (anchorClient.mode === "disabled") {
      await this.anchorFailed(input.id, "FINALIZE", new Error("Anchoring disabled"), requestId);
      return false;
    }
    try {
      let result: AnchorTransactionResult;
      let reconciled = false;
      if (existing?.transactionHash) {
        reconciled = true;
        result = await anchorClient.reconcileTransaction(
          existing.transactionHash as `0x${string}`,
        );
      } else {
        const chainState = await anchorClient.getPurchaseState(input.id);
        if (chainState.status !== "AUTHORIZED") {
          throw new Error(
            chainState.status === "FINALIZED"
              ? "Finalization is already on-chain, but its transaction hash is unavailable"
              : `Cannot finalize an on-chain purchase in ${chainState.status} state`,
          );
        }
        result = await anchorClient.finalizePurchase(
          {
            purchaseId: input.id,
            actualAmount: BigInt(input.actualAmountAtomic),
            settlementTxHash: input.settlementTxHash as `0x${string}`,
            receiptHash: input.receiptHash as `0x${string}`,
            invoiceHash: input.invoiceHash as `0x${string}`,
            reconciliationHash: input.reconciliationHash as `0x${string}`,
          },
          {
            onSubmitted: (transactionHash) =>
              this.recordAnchorSubmitted(
                input.id,
                "FINALIZE",
                transactionHash,
                requestId,
              ),
          },
        );
      }
      await this.confirmAnchor(input.id, "FINALIZE", result, requestId, reconciled);
      return true;
    } catch (error: unknown) {
      await this.recoverSubmittedHash(input.id, "FINALIZE", error, requestId);
      await this.anchorFailed(input.id, "FINALIZE", error, requestId, {
        clearSubmission: error instanceof AnchorTransactionRevertedError,
      });
      return false;
    }
  }

  private async failureAnchor(
    input: FailureAnchorInput,
    requestId?: string,
  ): Promise<boolean> {
    const { prisma, anchorClient, config } = this.dependencies;
    const existing = await beginAnchorAttempt(prisma, {
      purchaseId: input.id,
      kind: "FAIL",
      contractAddress: config.AUDIT_REGISTRY_ADDRESS ?? null,
      requestId,
    });
    if (anchorClient.mode === "disabled") {
      await this.anchorFailed(input.id, "FAIL", new Error("Anchoring disabled"), requestId);
      return false;
    }
    try {
      let result: AnchorTransactionResult;
      let reconciled = false;
      if (existing.transactionHash) {
        reconciled = true;
        result = await anchorClient.reconcileTransaction(
          existing.transactionHash as `0x${string}`,
        );
      } else {
        const chainState = await anchorClient.getPurchaseState(input.id);
        if (chainState.status !== "AUTHORIZED") {
          throw new Error(
            chainState.status === "FAILED"
              ? "Failure is already on-chain, but its transaction hash is unavailable"
              : `Cannot fail an on-chain purchase in ${chainState.status} state`,
          );
        }
        const reasonHash = hashCanonicalJson({
          schemaVersion: "1",
          kind: "PURCHASE_FAILURE",
          purchaseId: input.id,
          errorCode: input.errorCode,
        });
        result = await anchorClient.markFailed(input.id, reasonHash, {
          onSubmitted: (transactionHash) =>
            this.recordAnchorSubmitted(input.id, "FAIL", transactionHash, requestId),
        });
      }
      await this.confirmAnchor(input.id, "FAIL", result, requestId, reconciled);
      return true;
    } catch (error: unknown) {
      await this.recoverSubmittedHash(input.id, "FAIL", error, requestId);
      await this.anchorFailed(input.id, "FAIL", error, requestId, {
        clearSubmission: error instanceof AnchorTransactionRevertedError,
      });
      return false;
    }
  }

  private async recordAnchorSubmitted(
    purchaseId: string,
    kind: "AUTHORIZE" | "FINALIZE" | "FAIL",
    transactionHash: `0x${string}`,
    requestId?: string,
  ): Promise<void> {
    await this.dependencies.prisma.$transaction(async (transaction) => {
      const submitted = await transaction.onchainAnchor.updateMany({
        where: { purchaseId, kind, status: "PENDING" },
        data: {
          status: "SUBMITTED",
          transactionHash,
          submittedAt: this.now(),
          errorCode: null,
          errorMessage: null,
        },
      });
      if (submitted.count !== 1) {
        const current = await transaction.onchainAnchor.findUnique({
          where: { purchaseId_kind: { purchaseId, kind } },
          select: { status: true, transactionHash: true },
        });
        if (
          (current?.status === "SUBMITTED" || current?.status === "CONFIRMED") &&
          current.transactionHash === transactionHash
        ) {
          return;
        }
        throw new MelloError("CONTRACT_ANCHOR_FAILED", "Anchor state changed during submission", {
          statusCode: 409,
          retryable: true,
        });
      }
      await appendAuditEvent(transaction, {
        aggregateType: "ANCHOR",
        aggregateId: purchaseId,
        purchaseId,
        requestId,
        stage:
          kind === "AUTHORIZE"
            ? "AUTH_ANCHOR_PENDING"
            : kind === "FINALIZE"
              ? "FINAL_ANCHOR_PENDING"
              : "FAILED",
        eventType: `${kind}_ANCHOR_SUBMITTED`,
        payload: { transactionHash },
      });
    });
  }

  private async confirmAnchor(
    purchaseId: string,
    kind: "AUTHORIZE" | "FINALIZE" | "FAIL",
    result: AnchorTransactionResult,
    requestId: string | undefined,
    reconciled: boolean,
  ): Promise<void> {
    if (
      this.dependencies.anchorClient.mode === "onchain" &&
      result.chainId !== MELLO_CHAIN_ID
    ) {
      throw new MelloError(
        "CONTRACT_ANCHOR_FAILED",
        "Audit anchor receipt was not verified on Base Sepolia",
      );
    }
    await confirmAnchorState(this.dependencies.prisma, {
      purchaseId,
      kind,
      result,
      confirmedAt: this.now(),
      requestId,
      reconciled,
      anchorExplorerBase: anchorExplorerBaseForVerifiedConfirmation(
        this.dependencies.config,
        this.dependencies.anchorClient.mode,
        result,
      ),
    });
  }

  private async recoverSubmittedHash(
    purchaseId: string,
    kind: "AUTHORIZE" | "FINALIZE" | "FAIL",
    error: unknown,
    requestId?: string,
  ): Promise<void> {
    if (!(error instanceof AnchorSubmissionPersistenceError)) return;
    try {
      await this.recordAnchorSubmitted(purchaseId, kind, error.transactionHash, requestId);
    } catch (persistenceError: unknown) {
      this.dependencies.logger.error(
        { err: persistenceError, purchaseId, kind, transactionHash: error.transactionHash },
        "Could not recover a submitted anchor transaction hash",
      );
    }
  }

  private async anchorFailed(
    purchaseId: string,
    kind: "AUTHORIZE" | "FINALIZE" | "FAIL",
    error: unknown,
    requestId?: string,
    options: { clearSubmission?: boolean } = {},
  ): Promise<void> {
    const message = sanitizedErrorMessage(
      error,
      "Anchor provider returned an unknown error",
    );
    await this.dependencies.prisma.$transaction(async (transaction) => {
      const failed = await transaction.onchainAnchor.updateMany({
        where: { purchaseId, kind, status: { in: ["PENDING", "SUBMITTED"] } },
        data: {
          status: "FAILED_RETRYABLE",
          errorCode: "CONTRACT_ANCHOR_FAILED",
          errorMessage: message,
          ...(options.clearSubmission
            ? { transactionHash: null, submittedAt: null }
            : {}),
        },
      });
      if (failed.count !== 1) {
        const current = await transaction.onchainAnchor.findUnique({
          where: { purchaseId_kind: { purchaseId, kind } },
          select: { status: true },
        });
        if (current?.status === "FAILED_RETRYABLE") return;
        throw new MelloError("CONTRACT_ANCHOR_FAILED", "Anchor state changed before failure commit", {
          statusCode: 409,
          retryable: true,
        });
      }
      await appendAuditEvent(transaction, {
        aggregateType: "ANCHOR",
        aggregateId: purchaseId,
        purchaseId,
        requestId,
        stage:
          kind === "AUTHORIZE"
            ? "AUTH_ANCHOR_PENDING"
            : kind === "FINALIZE"
              ? "FINAL_ANCHOR_PENDING"
              : "FAILED",
        eventType: `${kind}_ANCHOR_FAILED_RETRYABLE`,
        payload: {
          errorCode: "CONTRACT_ANCHOR_FAILED",
          transactionReverted: options.clearSubmission === true,
        },
      });
    });
  }

  private async anchorConclusiveTerminalFailure(
    purchaseId: string,
    errorCode: string,
    requestId?: string,
  ): Promise<void> {
    try {
      const anchors = await this.dependencies.prisma.onchainAnchor.findMany({
        where: { purchaseId },
        select: { kind: true, status: true },
      });
      const authorizationConfirmed = anchors.some(
        (anchor) => anchor.kind === "AUTHORIZE" && anchor.status === "CONFIRMED",
      );
      const terminalAnchorConfirmed = anchors.some(
        (anchor) =>
          (anchor.kind === "FINALIZE" || anchor.kind === "FAIL") &&
          anchor.status === "CONFIRMED",
      );
      if (authorizationConfirmed && !terminalAnchorConfirmed) {
        await this.failureAnchor({ id: purchaseId, errorCode }, requestId);
      }
    } catch (anchorError: unknown) {
      this.dependencies.logger.error(
        { err: anchorError, purchaseId, requestId, stage: "FAILURE_ANCHOR" },
        "Could not start the terminal failure anchor",
      );
    }
  }

  private retryClaimCutoff(): Date {
    const leaseMs = Math.max(
      MIN_RETRY_CLAIM_LEASE_MS,
      this.dependencies.config.WORKFLOW_LEASE_MS * 2,
    );
    return new Date(this.now().getTime() - leaseMs);
  }

  private async setTaskStage(
    taskId: string,
    status: "DISCOVERING" | "EVALUATING",
    eventType: string,
    payload: unknown,
    requestId?: string,
    extraData: Prisma.TaskUpdateInput = {},
  ): Promise<void> {
    await this.dependencies.prisma.$transaction(async (transaction) => {
      const expectedStatus = status === "DISCOVERING" ? "PARSING" : "DISCOVERING";
      const taskTransition = await transaction.task.updateMany({
        where: { id: taskId, status: expectedStatus },
        data: { status, ...extraData },
      });
      if (taskTransition.count !== 1) {
        throw new MelloError("INTERNAL_ERROR", "Task stage changed during workflow execution", {
          statusCode: 409,
          retryable: true,
        });
      }
      await appendAuditEvent(transaction, {
        aggregateType: "TASK",
        aggregateId: taskId,
        taskId,
        requestId,
        stage: status,
        eventType,
        payload,
      });
    });
  }

  private async markActionRequired(
    taskId: string,
    purchaseId: string,
    errorCode: string,
    message: string,
    requestId?: string,
    eventType = errorCode,
  ): Promise<void> {
    const safeMessage = sanitizedErrorMessage(new Error(message), "Action required");
    await this.dependencies.prisma.$transaction(async (transaction) => {
      const [task, purchase] = await Promise.all([
        transaction.task.findUnique({ where: { id: taskId }, select: { status: true } }),
        transaction.purchase.findUnique({
          where: { id: purchaseId },
          select: { status: true, taskId: true },
        }),
      ]);
      if (!task || !purchase || purchase.taskId !== taskId) {
        throw new MelloError("NOT_FOUND", "Purchase workflow aggregate is missing", {
          statusCode: 404,
        });
      }
      if (task.status === "COMPLETED" || purchase.status === "COMPLETED") {
        throw new MelloError("INTERNAL_ERROR", "Completed purchase cannot require action", {
          statusCode: 409,
        });
      }
      await transitionPurchaseWorkflowStage(transaction, {
        taskId,
        purchaseId,
        expectedTaskStatuses: [task.status],
        expectedPurchaseStatuses: [purchase.status],
        nextTaskStatus: "ACTION_REQUIRED",
        nextPurchaseStatus: "ACTION_REQUIRED",
        taskData: { errorCode, errorMessage: safeMessage },
        aggregateType: "PURCHASE",
        aggregateId: purchaseId,
        requestId,
        stage: "ACTION_REQUIRED",
        eventType,
        payload: { message: safeMessage },
      });
    });
  }

  private async failTask(taskId: string, error: unknown, requestId?: string): Promise<void> {
    const code = error instanceof MelloError ? error.code : "INTERNAL_ERROR";
    const message = sanitizedErrorMessage(error, "Unexpected workflow error");
    const task = await this.dependencies.prisma.task.findUnique({
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
    if (
      !task ||
      ["COMPLETED", "REJECTED", "ACTION_REQUIRED", "FAILED"].includes(task.status)
    ) {
      return;
    }
    const paymentMayHaveExecuted =
      task.purchase?.payment?.status === "SETTLEMENT_PENDING" ||
      task.purchase?.payment?.status === "SETTLED";
    const authorizationMayHaveExecuted =
      task.purchase?.authorization?.status === "SUBMITTED" ||
      task.purchase?.authorization?.status === "SETTLED";
    const requiresAction = paymentMayHaveExecuted || authorizationMayHaveExecuted;
    await this.dependencies.prisma.$transaction(async (transaction) => {
      if (task.purchase) {
        await transitionPurchaseWorkflowStage(transaction, {
          taskId,
          purchaseId: task.purchase.id,
          expectedTaskStatuses: [task.status],
          expectedPurchaseStatuses: [task.purchase.status],
          nextTaskStatus: requiresAction ? "ACTION_REQUIRED" : "FAILED",
          nextPurchaseStatus: requiresAction ? "ACTION_REQUIRED" : "FAILED",
          taskData: { errorCode: code, errorMessage: message },
          aggregateType: "TASK",
          aggregateId: taskId,
          requestId,
          stage: requiresAction ? "PENDING_RECONCILIATION" : "FAILED",
          eventType: requiresAction ? "TASK_FAILURE_REQUIRES_ACTION" : "TASK_FAILED",
          payload: {
            errorCode: code,
            paymentMayHaveExecuted,
            authorizationMayHaveExecuted,
            automaticRepaymentAllowed: false,
          },
        });
      } else {
        const taskTransition = await transaction.task.updateMany({
          where: { id: taskId, status: task.status },
          data: { status: "FAILED", errorCode: code, errorMessage: message },
        });
        if (taskTransition.count !== 1) {
          throw new MelloError("INTERNAL_ERROR", "Task state changed before failure commit", {
            statusCode: 409,
            retryable: true,
          });
        }
        await appendAuditEvent(transaction, {
          aggregateType: "TASK",
          aggregateId: taskId,
          taskId,
          requestId,
          stage: "FAILED",
          eventType: "TASK_FAILED",
          payload: { errorCode: code },
        });
      }
    });
    if (task.purchase && !requiresAction) {
      await this.anchorConclusiveTerminalFailure(task.purchase.id, code, requestId);
    }
  }
}
