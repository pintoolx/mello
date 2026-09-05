import type { Logger } from "pino";
import type {
  CompanyProfileInput,
  PolicyInput,
  TaskStatus,
} from "@mello/shared";
import type { AppConfig } from "../config.js";
import type { ProcurementControls } from "../modules/controls/procurement-controls.js";
import type {
  WorkflowJobPoller,
  WorkflowJobQueue,
} from "../modules/workflow-jobs/contracts.js";

export interface PaginationInput {
  limit: number;
  offset: number;
}

export interface PaginatedResult {
  items: unknown[];
  total: number;
  limit: number;
  offset: number;
}

export interface TaskExecutionState {
  id: string;
  status: TaskStatus;
  purchaseId: string | null;
}

export interface PurchaseRetryState {
  id: string;
  taskId: string;
  invoiceRetryable: boolean;
  anchorRetryable: boolean;
  anchorPendingStatus: "AUTH_ANCHOR_PENDING" | "FINAL_ANCHOR_PENDING" | "FAILED" | null;
  paymentReconciliationAvailable: boolean;
}

export interface AuditEventFilter extends PaginationInput {
  aggregateType?: string | undefined;
  aggregateId?: string | undefined;
  taskId?: string | undefined;
  purchaseId?: string | undefined;
}

export interface BackgroundFailureInput {
  operation: "RUN_TASK" | "RETRY_INVOICE" | "RETRY_ANCHOR" | "RECONCILE_PAYMENT";
  taskId?: string | undefined;
  purchaseId?: string | undefined;
  requestId: string;
  error: unknown;
}

export interface CoreApiRepository {
  getCompany(): Promise<unknown | null>;
  saveCompany(input: CompanyProfileInput): Promise<unknown>;
  getActivePolicy(): Promise<unknown | null>;
  replaceActivePolicy(input: PolicyInput): Promise<unknown>;
  listSellers(): Promise<unknown[]>;
  listServices(category?: string): Promise<unknown[]>;
  createTask(prompt: string): Promise<{ id: string; status: TaskStatus }>;
  listTasks(pagination: PaginationInput): Promise<PaginatedResult>;
  getTaskExecutionState(taskId: string): Promise<TaskExecutionState | null>;
  getTaskDetail(taskId: string): Promise<unknown | null>;
  listPurchases(pagination: PaginationInput): Promise<PaginatedResult>;
  getPurchaseDetail(purchaseId: string): Promise<unknown | null>;
  getPurchaseRetryState(purchaseId: string): Promise<PurchaseRetryState | null>;
  listAuditEvents(filter: AuditEventFilter): Promise<PaginatedResult>;
  getDashboardSummary(): Promise<unknown>;
  resetDemo(): Promise<unknown>;
  recordBackgroundFailure(input: BackgroundFailureInput): Promise<void>;
}

export interface WorkflowOperations {
  run(taskId: string, requestId?: string): Promise<void>;
  retryInvoice(purchaseId: string, requestId?: string): Promise<void>;
  retryAnchor(purchaseId: string, requestId?: string): Promise<void>;
  reconcilePayment(purchaseId: string, requestId?: string): Promise<void>;
}

export interface HealthService {
  check(): Promise<unknown>;
}

export interface CoreApiDependencies {
  controls?: ProcurementControls;
  config: AppConfig;
  repository: CoreApiRepository;
  workflow: WorkflowOperations;
  healthService: HealthService;
  logger: Logger;
  workflowJobs: WorkflowJobQueue;
  workflowJobPoller: WorkflowJobPoller;
}
