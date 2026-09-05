export interface PageResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
export interface Modes {
  payment?: string;
  invoice?: string;
  anchor?: string;
  agent?: string;
}
export interface Company {
  legalName: string;
  businessId: string;
  defaultCostCenter: string;
}
export interface Policy {
  version: number;
  perTxLimitAtomic: string;
  dailyLimitAtomic: string;
  requireTwInvoice: boolean;
  allowedSellerIds: string[];
  allowedNetworks: string[];
}
export interface Service {
  id?: string;
  serviceId?: string;
  sellerId: string;
  sellerLegalName: string;
  priceAtomic: string;
  supportsTwInvoice: boolean;
  payToAddress: string;
  eligible?: boolean;
  reasonCodes?: string[];
  humanSummary?: string;
}
export interface Settings {
  company: Company | null;
  policy: Policy | null;
  services: Service[];
}
export interface AuditEvent {
  id: string;
  eventType: string;
  createdAt: string;
  taskId?: string;
  purchaseId?: string;
  sequence: string;
  payload?: unknown;
}
export interface TaskRow {
  taskId: string;
  prompt: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  purchaseId: string | null;
  decisionSummary?: string | null;
}
export interface Intent {
  targetCompanyName: string;
  maxAmount: { atomic: string };
  buyerBusinessId: string;
  costCenter: string;
  usedDemoDefaultTarget?: boolean;
}
export interface Purchase {
  purchaseId: string;
  taskId: string;
  status: string;
  prompt: string;
  modes?: Modes;
  paymentMode?: string;
  selectedService: Service;
  expectedAmountAtomic: string;
  actualAmountAtomic: string | null;
  createdAt: string;
  updatedAt: string;
  payToAddress?: string;
  network?: string;
  policyHash?: string;
  paymentAuthorizationHash?: string;
  policyDecision?: { approved?: boolean };
  policySnapshot?: Policy;
  payment: { status: string; transactionHash?: string | null } | null;
  paymentAuthorization?: { paymentId: string; status: string } | null;
  authorization?: { paymentId: string; status: string } | null;
  delivery?: { status: string; responseBody?: unknown } | null;
  invoice: {
    status: string;
    invoiceNumber?: string | null;
    lastError?: string | null;
  } | null;
  reconciliation: { status: string } | null;
  anchors?: { kind: string; status: string; transactionHash: string | null }[];
  availableActions?: {
    retryInvoice: boolean;
    retryAnchor: boolean;
    reconcilePayment: boolean;
  };
}
export interface Task extends TaskRow {
  intent: Intent | null;
  candidates: Service[] | null;
  error: { code: string; message: string } | null;
  purchase: Purchase | null;
  timeline: AuditEvent[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public requestId?: string,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      ...init,
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ApiError(
      "無法連線，請稍後重新整理。若剛送出申請，請先至採購清單確認是否已建立。",
      "CONNECTION_ERROR",
    );
  }
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      body?.error?.message || "服務暫時無法連線，請確認後端已啟動後再試。",
      body?.error?.code || "SERVICE_UNAVAILABLE",
      body?.error?.requestId,
    );
  return body as T;
}
export const running = (status: string) =>
  [
    "PARSING",
    "DISCOVERING",
    "EVALUATING",
    "AUTH_ANCHOR_PENDING",
    "PAYING",
    "DELIVERING",
    "INVOICING",
    "RECONCILING",
    "FINAL_ANCHOR_PENDING",
  ].includes(status);
const labels: Record<string, string> = {
  CREATED: "待送出",
  PARSING: "受理中",
  DISCOVERING: "查詢供應商",
  EVALUATING: "審核中",
  REJECTED: "未核准",
  AUTH_ANCHOR_PENDING: "授權確認中",
  PAYING: "付款中",
  DELIVERING: "交付中",
  INVOICING: "取得發票中",
  RECONCILING: "對帳中",
  FINAL_ANCHOR_PENDING: "歸檔確認中",
  COMPLETED: "已完成",
  ACTION_REQUIRED: "待處理",
  FAILED: "處理失敗",
  NOT_STARTED: "尚未開始",
  AUTHORIZED: "已授權",
  SETTLEMENT_PENDING: "付款待確認",
  SETTLED: "已付款",
  DELIVERED: "已交付",
  PENDING: "待處理",
  MATCHED: "已對帳",
  MISMATCH: "對帳差異",
  NOT_REQUIRED: "不需發票",
  ISSUED_DEMO: "測試發票已取得",
  ISSUED_STAGE: "測試發票已取得",
  FAILED_RETRYABLE: "可重試",
  FAILED_FINAL: "取得失敗",
  CONFIRMED: "已確認",
  SUBMITTED: "已送出",
};
export const statusLabel = (status?: string | null) =>
  status ? labels[status] || status : "—";
export function money(value?: string | null): string {
  if (!value || !/^\d+$/.test(value)) return "—";
  const amount = BigInt(value);
  const units = BigInt(1000000);
  const fraction = String(amount % units)
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `${amount / units}${fraction ? `.${fraction}` : ".00"}`;
}
export const dateTime = (value?: string) =>
  value
    ? new Date(value).toLocaleString("zh-TW", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "—";
export const shortId = (value: string) => value.slice(0, 8).toUpperCase();
