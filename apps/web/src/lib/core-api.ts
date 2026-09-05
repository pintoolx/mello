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
  email: string;
  contactName?: string;
  phone?: string;
  address?: string;
  invoiceEmail?: string;
  invoiceAddress?: string;
}
export interface Health {
  modes: Modes;
  checks?: {
    baseRpc?: { status: string; details?: { chainId?: number } };
    buyerWallet?: { status: string; details?: { simulated?: boolean; usdcBalanceAtomic?: string } };
  };
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
  displayName?: string | null;
  matchesRequirements?: boolean;
  selectionHash?: string;
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
  discoverySource?: string;
  verificationStatus?: string;
  verification?: { status: string; expiresAt: string | null; revision: number | null; bindingHash: string };
}
export interface Settings {
  discoveryMode?: "local_demo" | "bazaar";
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
  requiresTwInvoice?: boolean;
  targetCompanyName: string;
  maxAmount: { atomic: string };
  buyerBusinessId: string;
  costCenter: string;
  usedDemoDefaultTarget?: boolean;
}
export interface Purchase {
  discoveryEvidence?: { source: "cdp_bazaar" | "local_registry"; fetchedAt: string; resource: string; verificationRevision: number | null; requiresCertification?: boolean; bindingHash: string } | null;
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
    buyerProfile?: { legalName: string; businessId: string; email: string; address: string } | null;
    invoiceNumber?: string | null;
    lastError?: string | null;
  } | null;
  reconciliation: { status: string } | null;
  anchors?: { kind: string; status: string; transactionHash: string | null }[];
  explorerLinks?: { payment: string | null; anchor: string | null };
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
  control: {
    requirements?: { requiresTwInvoice: boolean; requiresRegistryCertification: boolean } | null;
    selectedService?: { serviceId: string; selectionHash: string } | null;
    requestKey: string;
    approvalLimitAtomic: string | null;
    expectedPayTo: string | null;
    pendingTerms: {
      serviceId: string;
      sellerId: string;
      amountAtomic: string;
      payTo: string;
      network: string;
      token: string;
    } | null;
    approvedAt: string | null;
  } | null;
}

export interface Control {
  paymentsFrozen: boolean;
  updatedAt: string | null;
}

export const SESSION_EXPIRED = "mello:session-expired";

export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public requestId?: string,
    public status?: number,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  return requestJson<T>(`/api/v1${path}`, init);
}

export async function requestJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      cache: "no-store",
      credentials: "same-origin",
      signal: init?.signal ?? AbortSignal.timeout(35_000),
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ApiError(
      "無法連線，請重新讀取既有案件。建立申請時若回應遺失，請用原請求找回，不要另建付款。",
      "CONNECTION_ERROR",
    );
  }
  const body = await response.json().catch(() => null);
  if (
    response.status === 401 &&
    path.startsWith("/api/v1/") &&
    !init?.signal?.aborted &&
    typeof window !== "undefined"
  ) {
    window.dispatchEvent(new Event(SESSION_EXPIRED));
  }
  if (!response.ok)
    throw new ApiError(
      body?.error?.message || "服務暫時無法連線，請確認後端已啟動後再試。",
      body?.error?.code || "SERVICE_UNAVAILABLE",
      body?.error?.requestId,
      response.status,
    );
  if (body === null)
    throw new ApiError(
      "後端回應格式異常，請重新讀取狀態。",
      "INVALID_RESPONSE",
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
  CREATED: "待探索",
  WAITING_SELECTION: "待選擇服務",
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
