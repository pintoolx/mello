import type { AnchorTransactionResult } from "@mello/contracts-client";
import type {
  OnchainAnchor,
  Prisma,
  PrismaClient,
  PurchaseStatus,
  TaskStatus,
} from "@mello/db";
import { MelloError } from "@mello/shared";
import { appendAuditEvent } from "../audit/index.js";
import type { InvoiceIssueResult } from "../invoices/index.js";

export type AnchorAttemptKind = "AUTHORIZE" | "FINALIZE" | "FAIL";

function anchorStage(kind: AnchorAttemptKind): string {
  if (kind === "AUTHORIZE") return "AUTH_ANCHOR_PENDING";
  if (kind === "FINALIZE") return "FINAL_ANCHOR_PENDING";
  return "FAILED";
}

export interface WorkflowAuditContext {
  taskId?: string | undefined;
  purchaseId?: string | undefined;
  paymentId?: string | undefined;
  sellerId?: string | undefined;
  requestId?: string | undefined;
}

export interface PurchaseWorkflowStageTransitionInput extends WorkflowAuditContext {
  taskId: string;
  purchaseId: string;
  expectedTaskStatuses: readonly TaskStatus[];
  expectedPurchaseStatuses: readonly PurchaseStatus[];
  nextTaskStatus: TaskStatus;
  nextPurchaseStatus: PurchaseStatus;
  taskData?: Omit<Prisma.TaskUpdateManyMutationInput, "status"> | undefined;
  purchaseData?: Omit<Prisma.PurchaseUpdateManyMutationInput, "status"> | undefined;
  aggregateType: "TASK" | "PURCHASE" | "PAYMENT" | "INVOICE" | "ANCHOR";
  aggregateId: string;
  stage: string;
  eventType: string;
  actorType?: "SYSTEM" | "USER" | undefined;
  payload: unknown;
}

/**
 * Advances the Task/Purchase aggregate with compare-and-set semantics and
 * appends the transition evidence on the caller's transaction. Any stale
 * status or audit insertion failure aborts the whole transaction.
 */
export async function transitionPurchaseWorkflowStage(
  transaction: Prisma.TransactionClient,
  input: PurchaseWorkflowStageTransitionInput,
): Promise<void> {
  const taskTransition = await transaction.task.updateMany({
    where: {
      id: input.taskId,
      status: { in: [...input.expectedTaskStatuses] },
    },
    data: {
      ...input.taskData,
      status: input.nextTaskStatus,
    },
  });
  const purchaseTransition = await transaction.purchase.updateMany({
    where: {
      id: input.purchaseId,
      taskId: input.taskId,
      status: { in: [...input.expectedPurchaseStatuses] },
    },
    data: {
      ...input.purchaseData,
      status: input.nextPurchaseStatus,
    },
  });
  if (taskTransition.count !== 1 || purchaseTransition.count !== 1) {
    throw new MelloError("INTERNAL_ERROR", "Workflow state changed during transition", {
      statusCode: 409,
      retryable: true,
      details: {
        taskId: input.taskId,
        purchaseId: input.purchaseId,
        expectedTaskStatuses: input.expectedTaskStatuses,
        expectedPurchaseStatuses: input.expectedPurchaseStatuses,
        nextTaskStatus: input.nextTaskStatus,
        nextPurchaseStatus: input.nextPurchaseStatus,
      },
    });
  }

  await appendAuditEvent(transaction, {
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    taskId: input.taskId,
    purchaseId: input.purchaseId,
    paymentId: input.paymentId,
    sellerId: input.sellerId,
    requestId: input.requestId,
    stage: input.stage,
    eventType: input.eventType,
    ...(input.actorType ? { actorType: input.actorType } : {}),
    payload: input.payload,
  });
}

export async function startTaskRun(
  prisma: PrismaClient,
  input: { taskId: string; startedAt: Date; requestId?: string | undefined },
): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    const started = await transaction.task.updateMany({
      where: { id: input.taskId, status: "CREATED" },
      data: {
        status: "PARSING",
        runStartedAt: input.startedAt,
        errorCode: null,
        errorMessage: null,
      },
    });
    if (started.count !== 1) {
      throw new MelloError("TASK_ALREADY_RUNNING", "Task is already running", {
        statusCode: 409,
      });
    }
    await appendAuditEvent(transaction, {
      aggregateType: "TASK",
      aggregateId: input.taskId,
      taskId: input.taskId,
      requestId: input.requestId,
      stage: "PARSING",
      eventType: "TASK_RUN_STARTED",
      payload: { previousStatus: "CREATED" },
    });
  });
}

export async function persistIssuedInvoice(
  prisma: PrismaClient,
  input: WorkflowAuditContext & {
    invoiceId: string;
    invoice: InvoiceIssueResult;
  },
): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    const current = await transaction.invoice.findUnique({
      where: { id: input.invoiceId },
      select: { status: true, attemptCount: true },
    });
    if (!current || (current.status !== "PENDING" && current.status !== "FAILED_RETRYABLE")) {
      throw new MelloError("INVOICE_ISSUE_FAILED", "Invoice state changed while issuing", {
        statusCode: 409,
      });
    }

    const persisted = await transaction.invoice.updateMany({
      where: {
        id: input.invoiceId,
        status: current.status,
        attemptCount: current.attemptCount,
      },
      data: {
        status: input.invoice.status,
        provider: input.invoice.provider,
        providerReference: input.invoice.providerReference,
        invoiceNumber: input.invoice.invoiceNumber,
        buyerBusinessId: input.invoice.buyerBusinessId,
        sellerBusinessId: input.invoice.sellerBusinessId,
        sellerProfileId: input.invoice.sellerProfileId,
        sourceAmountAtomic: input.invoice.sourceAmountAtomic,
        fxRateTwdPerUsdc: input.invoice.fxRateTwdPerUsdc,
        twdEquivalentMinor: input.invoice.twdEquivalentMinor,
        itemName: input.invoice.itemName,
        paymentId: input.invoice.paymentId,
        paymentTxHash: input.invoice.paymentTxHash,
        canonicalHash: input.invoice.canonicalHash,
        disclaimer: input.invoice.disclaimer,
        attemptCount: { increment: 1 },
        lastError: null,
        issuedAt: new Date(input.invoice.issuedAt),
      },
    });
    if (persisted.count !== 1) {
      throw new MelloError("INVOICE_ISSUE_FAILED", "Invoice state changed while issuing", {
        statusCode: 409,
      });
    }

    await appendAuditEvent(transaction, {
      aggregateType: "INVOICE",
      aggregateId: input.invoiceId,
      taskId: input.taskId,
      purchaseId: input.purchaseId,
      paymentId: input.paymentId,
      sellerId: input.sellerId,
      requestId: input.requestId,
      stage: "INVOICING",
      eventType: "INVOICE_ISSUED",
      payload: {
        previousStatus: current.status,
        status: input.invoice.status,
        provider: input.invoice.provider,
        providerReference: input.invoice.providerReference,
        invoiceNumber: input.invoice.invoiceNumber,
        canonicalHash: input.invoice.canonicalHash,
        attempt: current.attemptCount + 1,
      },
    });
  });
}

export async function beginAnchorAttempt(
  prisma: PrismaClient,
  input: WorkflowAuditContext & {
    kind: AnchorAttemptKind;
    contractAddress: string | null;
  },
): Promise<OnchainAnchor> {
  if (!input.purchaseId) throw new Error("purchaseId is required for an anchor attempt");
  const purchaseId = input.purchaseId;

  return prisma.$transaction(async (transaction) => {
    const current = await transaction.onchainAnchor.findUnique({
      where: { purchaseId_kind: { purchaseId, kind: input.kind } },
    });
    if (!current) {
      throw new MelloError("NOT_FOUND", "On-chain anchor not found", { statusCode: 404 });
    }
    if (current.status !== "NOT_STARTED" && current.status !== "FAILED_RETRYABLE") {
      throw new MelloError("CONTRACT_ANCHOR_FAILED", "Anchor attempt is already active", {
        statusCode: 409,
      });
    }

    const started = await transaction.onchainAnchor.updateMany({
      where: {
        id: current.id,
        status: current.status,
        attemptCount: current.attemptCount,
      },
      data: {
        status: "PENDING",
        attemptCount: { increment: 1 },
        contractAddress: input.contractAddress,
        errorCode: null,
        errorMessage: null,
      },
    });
    if (started.count !== 1) {
      throw new MelloError("CONTRACT_ANCHOR_FAILED", "Anchor state changed while starting", {
        statusCode: 409,
      });
    }

    await appendAuditEvent(transaction, {
      aggregateType: "ANCHOR",
      aggregateId: purchaseId,
      taskId: input.taskId,
      purchaseId,
      paymentId: input.paymentId,
      sellerId: input.sellerId,
      requestId: input.requestId,
      stage: anchorStage(input.kind),
      eventType: `${input.kind}_ANCHOR_ATTEMPT_STARTED`,
      payload: {
        previousStatus: current.status,
        attempt: current.attemptCount + 1,
        hasSubmittedTransaction: current.transactionHash !== null,
      },
    });

    return {
      ...current,
      status: "PENDING",
      attemptCount: current.attemptCount + 1,
      contractAddress: input.contractAddress,
      errorCode: null,
      errorMessage: null,
    };
  });
}

export async function confirmAnchorState(
  prisma: PrismaClient,
  input: WorkflowAuditContext & {
    kind: AnchorAttemptKind;
    result: AnchorTransactionResult;
    confirmedAt: Date;
    reconciled: boolean;
    anchorExplorerBase?: string | null | undefined;
  },
): Promise<void> {
  if (!input.purchaseId) throw new Error("purchaseId is required to confirm an anchor");
  const purchaseId = input.purchaseId;

  await prisma.$transaction(async (transaction) => {
    const current = await transaction.onchainAnchor.findUnique({
      where: { purchaseId_kind: { purchaseId, kind: input.kind } },
      select: { id: true, status: true, transactionHash: true },
    });
    if (!current || (current.status !== "PENDING" && current.status !== "SUBMITTED")) {
      throw new MelloError("CONTRACT_ANCHOR_FAILED", "Anchor state changed before confirmation", {
        statusCode: 409,
      });
    }

    const confirmed = await transaction.onchainAnchor.updateMany({
      where: {
        id: current.id,
        status: current.status,
        transactionHash: current.transactionHash,
      },
      data: {
        status: "CONFIRMED",
        transactionHash: input.result.transactionHash,
        blockNumber: input.result.blockNumber,
        confirmedAt: input.confirmedAt,
        errorCode: null,
        errorMessage: null,
      },
    });
    if (confirmed.count !== 1) {
      throw new MelloError("CONTRACT_ANCHOR_FAILED", "Anchor state changed before confirmation", {
        statusCode: 409,
      });
    }

    let anchorExplorerEvidenceRecorded = false;
    if (input.anchorExplorerBase) {
      const evidence = await transaction.purchase.updateMany({
        where: {
          id: purchaseId,
          status: {
            in:
              input.kind === "AUTHORIZE"
                ? ["AUTH_ANCHOR_PENDING", "ACTION_REQUIRED"]
                : input.kind === "FINALIZE"
                  ? ["FINAL_ANCHOR_PENDING", "ACTION_REQUIRED"]
                  : ["FAILED"],
          },
          OR: [
            { anchorExplorerBase: null },
            { anchorExplorerBase: input.anchorExplorerBase },
          ],
        },
        data: { anchorExplorerBase: input.anchorExplorerBase },
      });
      if (evidence.count !== 1) {
        throw new MelloError(
          "CONTRACT_ANCHOR_FAILED",
          "Purchase state changed before anchor explorer evidence was recorded",
          { statusCode: 409 },
        );
      }
      anchorExplorerEvidenceRecorded = true;
    }

    let purchaseAdvancedToAuthorized = false;
    if (input.kind === "AUTHORIZE") {
      const purchase = await transaction.purchase.updateMany({
        where: { id: purchaseId, status: "AUTH_ANCHOR_PENDING" },
        data: { status: "AUTHORIZED" },
      });
      purchaseAdvancedToAuthorized = purchase.count === 1;
    }

    await appendAuditEvent(transaction, {
      aggregateType: "ANCHOR",
      aggregateId: purchaseId,
      taskId: input.taskId,
      purchaseId,
      paymentId: input.paymentId,
      sellerId: input.sellerId,
      requestId: input.requestId,
      stage: anchorStage(input.kind),
      eventType:
        input.kind === "AUTHORIZE"
          ? "AUTHORIZATION_ANCHOR_CONFIRMED"
          : input.kind === "FINALIZE"
            ? "FINALIZATION_ANCHOR_CONFIRMED"
            : "FAILURE_ANCHOR_CONFIRMED",
      payload: {
        ...input.result,
        reconciled: input.reconciled,
        purchaseAdvancedToAuthorized,
        anchorExplorerEvidenceRecorded,
      },
    });
  });
}
