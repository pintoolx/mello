import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@mello/db";
import { hashCanonicalJson, MelloError, parseUsdcToAtomic, ServiceSelectionSchema, TaskRequirementsSchema, type CreateTaskSchema, type ServiceRecord, type ServiceSelection } from "@mello/shared";
import type { z } from "zod";
import { appendAuditEvent, jsonValue } from "../audit/index.js";

export type ConsoleTaskInput = z.infer<typeof CreateTaskSchema>;
const GATE_LOCK = "mello:payment-release-gate";

function approvalThreshold(prompt: string): string | undefined {
  const match = /超過\s*(\d+(?:\.\d{1,6})?)\s*USDC\s*(?:先問我|需(?:要)?核准|先核准)/iu.exec(prompt);
  return match?.[1] ? parseUsdcToAtomic(match[1]) : undefined;
}

export function approvalTerms(service: ServiceRecord) {
  return { serviceId: service.id, sellerId: service.sellerId, amountAtomic: service.priceAtomic,
    payTo: service.payToAddress.toLowerCase(), token: service.tokenAddress.toLowerCase(), network: service.network };
}

export class ProcurementControls {
  constructor(private readonly prisma: PrismaClient) {}

  async state() {
    const row = await this.prisma.paymentControl.findUnique({ where: { id: "global" } });
    return { paymentsFrozen: row?.paymentsFrozen ?? false, updatedAt: row?.updatedAt ?? null };
  }

  async setFrozen(paymentsFrozen: boolean) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${GATE_LOCK}, 0)) IS NULL AS acquired`;
      const state = await tx.paymentControl.upsert({ where: { id: "global" },
        create: { id: "global", paymentsFrozen }, update: { paymentsFrozen } });
      await tx.auditEvent.create({ data: { aggregateType: "CONTROL", aggregateId: "global", actorType: "USER",
        eventType: paymentsFrozen ? "PAYMENTS_FROZEN" : "PAYMENTS_UNFROZEN",
        payload: { paymentsFrozen, boundary: "NEW_PAYMENT_RELEASE_PERMITS", inFlightPaymentsAreNotCancelled: true } } });
      return state;
    });
  }

  async ensureNotFrozen() {
    if ((await this.state()).paymentsFrozen) throw new MelloError("PAYMENTS_FROZEN", "新付款已由管理員凍結", { statusCode: 409 });
  }

  async createTask(input: ConsoleTaskInput) {
    const requestKey = input.requestKey ?? randomUUID();
    const limits = [input.approvalLimitAtomic, approvalThreshold(input.prompt)].filter((value): value is string => value !== undefined);
    const limit = limits.length ? limits.reduce((a, b) => BigInt(a) <= BigInt(b) ? a : b) : null;
    const expectedPayTo = input.expectedPayTo?.toLowerCase() ?? null;
    const requestHash = hashCanonicalJson({ prompt: input.prompt, approvalLimitAtomic: limit, expectedPayTo,
      ...(input.requirements ? { requirements: input.requirements } : {}) });
    const existing = await this.prisma.taskControl.findUnique({ where: { requestKey }, include: { task: true } });
    const replay = async (record: NonNullable<typeof existing>) => {
      if (record.requestHash !== requestHash) throw new MelloError("IDEMPOTENCY_CONFLICT", "同一採購請求編號不能搭配不同內容", { statusCode: 409 });
      await appendAuditEvent(this.prisma, { aggregateType: "TASK", aggregateId: record.taskId, taskId: record.taskId,
        eventType: "PURCHASE_REQUEST_DEDUPLICATED", actorType: "USER", payload: { requestKey, existingTaskId: record.taskId, newPaymentCreated: false } });
      return { id: record.taskId, status: record.task.status, deduplicated: true, requestKey };
    };
    if (existing) return replay(existing);
    await this.ensureNotFrozen();
    try {
      const task = await this.prisma.task.create({ data: { prompt: input.prompt, control: { create: {
        requestKey, requestHash, approvalLimitAtomic: limit, expectedPayTo,
        ...(input.requirements ? { requirements: jsonValue(input.requirements) } : {}),
      } } } });
      return { id: task.id, status: task.status, deduplicated: false, requestKey };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const winner = await this.prisma.taskControl.findUnique({ where: { requestKey }, include: { task: true } });
        if (winner) return replay(winner);
      }
      throw error;
    }
  }

  async detail(taskId: string) {
    const control = await this.prisma.taskControl.findUnique({ where: { taskId } });
    if (!control) return null;
    return { requestKey: control.requestKey, approvalLimitAtomic: control.approvalLimitAtomic, expectedPayTo: control.expectedPayTo,
      requirements: control.requirements, selectedService: control.selectedService,
      pendingTerms: control.pendingTerms, approvedAt: control.approvedAt, paymentReleaseGrantedAt: control.paymentReleaseGrantedAt };
  }

  async discover(taskId: string, enqueue: (tx: Prisma.TransactionClient) => Promise<unknown>, requestId?: string) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`mello:selection:${taskId}`}, 0)) IS NULL AS acquired`;
      const task = await tx.task.findUnique({ where: { id: taskId }, include: { control: true, purchase: true } });
      if (!task) throw new MelloError("NOT_FOUND", "Task not found", { statusCode: 404 });
      if (task.purchase || !["CREATED", "WAITING_SELECTION", "FAILED"].includes(task.status) ||
        (task.control?.selectedService && task.status !== "FAILED")) {
        throw new MelloError("TASK_ALREADY_RUNNING", "此案件已送出採購或仍在處理，請重新讀取。", { statusCode: 409 });
      }
      // Old drafts gain the same human-selection boundary when opened in the console.
      const requirements = TaskRequirementsSchema.parse(task.control?.requirements ?? {
        requiresTwInvoice: true, requiresRegistryCertification: true,
      });
      await tx.taskControl.upsert({ where: { taskId }, create: {
        taskId, requestKey: randomUUID(), requestHash: hashCanonicalJson({ prompt: task.prompt }),
        requirements: jsonValue(requirements),
      }, update: { requirements: jsonValue(requirements), selectedService: Prisma.DbNull } });
      await tx.task.update({ where: { id: taskId }, data: {
        status: "CREATED", errorCode: null, errorMessage: null, completedAt: null, runStartedAt: null,
      } });
      await appendAuditEvent(tx, { aggregateType: "TASK", aggregateId: taskId, taskId, requestId,
        actorType: "USER", eventType: "SERVICE_SURVEY_REQUESTED", payload: { requirements, paymentCreated: false } });
      await enqueue(tx);
    });
  }

  async selectService(taskId: string, input: ServiceSelection,
    enqueue: (tx: Prisma.TransactionClient) => Promise<unknown>, requestId?: string) {
    await this.ensureNotFrozen();
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`mello:selection:${taskId}`}, 0)) IS NULL AS acquired`;
      const task = await tx.task.findUnique({ where: { id: taskId }, include: { control: true, purchase: true } });
      if (!task) throw new MelloError("NOT_FOUND", "Task not found", { statusCode: 404 });
      const previous = ServiceSelectionSchema.safeParse(task.control?.selectedService);
      if (previous.success && previous.data.serviceId === input.serviceId && previous.data.selectionHash === input.selectionHash) {
        return { status: task.status, deduplicated: true };
      }
      if (task.status !== "WAITING_SELECTION" || task.purchase || !task.control?.requirements) {
        throw new MelloError("TASK_ALREADY_RUNNING", "請先完成服務探索，再選擇要採購的服務。", { statusCode: 409 });
      }
      const candidates = Array.isArray(task.candidates) ? task.candidates : [];
      const candidate = candidates.find((value) => value && typeof value === "object" && !Array.isArray(value) &&
        value["serviceId"] === input.serviceId && value["selectionHash"] === input.selectionHash);
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) ||
        candidate["eligible"] !== true || candidate["matchesRequirements"] !== true) {
        throw new MelloError("NO_ELIGIBLE_SERVICE", "請選擇本次探索中符合條件的服務；報價已更新時請重新選擇。", { statusCode: 409 });
      }
      await tx.taskControl.update({ where: { taskId }, data: { selectedService: jsonValue(input) } });
      await tx.task.update({ where: { id: taskId }, data: {
        status: "CREATED", errorCode: null, errorMessage: null, runStartedAt: null,
        decisionSummary: "已確認選用服務，等待付款前檢查。",
      } });
      await appendAuditEvent(tx, { aggregateType: "TASK", aggregateId: taskId, taskId, requestId,
        actorType: "USER", eventType: "SERVICE_SELECTED_BY_USER", payload: { ...input, candidate } });
      // Selection and durable dispatch commit together, including on a lost HTTP response.
      await enqueue(tx);
      return { status: "PARSING", deduplicated: false };
    });
  }

  // Runs before purchase creation: a paused approval cannot hold a spend reservation or payment signature.
  async assess(taskId: string, service: ServiceRecord, requestId?: string): Promise<boolean> {
    await this.ensureNotFrozen();
    const control = await this.prisma.taskControl.findUnique({ where: { taskId } });
    if (!control) return true;
    if (control.expectedPayTo && control.expectedPayTo !== service.payToAddress.toLowerCase()) {
      await this.prisma.$transaction(async (tx) => {
        await tx.task.update({ where: { id: taskId }, data: { status: "REJECTED", errorCode: "POLICY_REJECTED",
          errorMessage: "PAY_TO_MISMATCH：採購要求的收款地址與 registry 不符", completedAt: new Date() } });
        await appendAuditEvent(tx, { aggregateType: "TASK", aggregateId: taskId, taskId, requestId,
          eventType: "TASK_REJECTED", stage: "EVALUATING", payload: { reasonCode: "PAY_TO_MISMATCH", paymentCreated: false } });
      });
      return false;
    }
    if (control.approvalLimitAtomic === null || BigInt(service.priceAtomic) <= BigInt(control.approvalLimitAtomic)) return true;
    const terms = approvalTerms(service);
    if (control.approvedTermsHash === hashCanonicalJson(terms)) return true;
    await this.prisma.$transaction(async (tx) => {
      await tx.taskControl.update({ where: { taskId }, data: { pendingTerms: jsonValue(terms), approvedTermsHash: null, approvedAt: null } });
      await tx.task.update({ where: { id: taskId }, data: { status: "ACTION_REQUIRED", errorCode: "APPROVAL_REQUIRED",
        errorMessage: "報價超過核准門檻，請確認供應商、金額與收款地址後核准", decisionSummary: "等待人工核准；尚未建立付款。" } });
      await appendAuditEvent(tx, { aggregateType: "TASK", aggregateId: taskId, taskId, requestId,
        eventType: "APPROVAL_REQUESTED", actorType: "SYSTEM", stage: "EVALUATING", payload: terms });
    });
    return false;
  }

  async approve(taskId: string, requestId?: string) {
    await this.ensureNotFrozen();
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`mello:approve:${taskId}`}, 0)) IS NULL AS acquired`;
      const task = await tx.task.findUnique({ where: { id: taskId }, include: { control: true, purchase: true } });
      if (!task) throw new MelloError("NOT_FOUND", "Task not found", { statusCode: 404 });
      if (task.status !== "ACTION_REQUIRED" || task.errorCode !== "APPROVAL_REQUIRED" || task.purchase || !task.control?.pendingTerms) {
        throw new MelloError("APPROVAL_REQUIRED", "此任務目前沒有待核准報價", { statusCode: 409 });
      }
      await tx.taskControl.update({ where: { taskId }, data: { approvedTermsHash: hashCanonicalJson(task.control.pendingTerms), approvedAt: new Date() } });
      await tx.task.update({ where: { id: taskId }, data: { status: "CREATED", errorCode: null, errorMessage: null, runStartedAt: null } });
      await appendAuditEvent(tx, { aggregateType: "TASK", aggregateId: taskId, taskId, requestId,
        eventType: "PURCHASE_APPROVED", actorType: "USER", payload: task.control.pendingTerms });
    });
  }

  // This short transaction is the cutoff shared with freeze. A granted permit is in-flight;
  // freeze does not revoke it. Never hold a database lock during an external payment request.
  async claimPaymentRelease(taskId: string, purchaseId: string, requestId?: string, transaction?: Prisma.TransactionClient) {
    const claim = async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${GATE_LOCK}, 0)) IS NULL AS acquired`;
      const state = await tx.paymentControl.findUnique({ where: { id: "global" } });
      if (state?.paymentsFrozen) throw new MelloError("PAYMENTS_FROZEN", "付款已凍結，未核發送出許可", { statusCode: 409 });
      await tx.taskControl.updateMany({ where: { taskId }, data: { paymentReleaseGrantedAt: new Date() } });
      await appendAuditEvent(tx, { aggregateType: "PAYMENT", aggregateId: purchaseId, taskId, purchaseId, requestId,
        eventType: "PAYMENT_RELEASE_PERMIT_GRANTED", stage: "PAYING", payload: { boundary: "BEFORE_SIGNED_PAID_REQUEST_RELEASE" } });
    };
    if (transaction) await claim(transaction);
    else await this.prisma.$transaction(claim);
  }
}
