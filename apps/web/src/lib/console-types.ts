// JSON-only browser DTOs. Do not import wallet, Prisma or the API's shared barrel.
export type Modes = { agent: string; payment: string; invoice: string; anchor: string };
export type Service = { id: string; sellerId: string; sellerLegalName: string; priceAtomic: string; supportsTwInvoice: boolean; payToAddress: string };
export type Settings = { company: { legalName: string; businessId: string; defaultCostCenter: string }; policy: { version: number; perTxLimitAtomic: string; dailyLimitAtomic: string; allowedSellerIds: string[] }; services: Service[] };
export type Health = { status: string; checkedAt: string; modes: Modes; checks: Record<string, { status: string }> };
export type Control = { paymentsFrozen: boolean; updatedAt: string | null };
export type AuditEvent = { id: string; sequence: string; createdAt: string; eventType: string; payload: Record<string, unknown> };
export type Candidate = { serviceId: string; sellerId: string; sellerLegalName: string; priceAtomic: string; supportsTwInvoice: boolean; eligible: boolean; reasonCodes: string[]; humanSummary: string };
export type Purchase = {
  purchaseId: string; status: string; selectedService: Service; expectedAmountAtomic: string; payToAddress: string;
  modes: Modes; policyDecision: { approved: boolean; reasonCodes: string[]; policyVersion?: number } | null;
  policySnapshot: { version?: number };
  paymentAuthorization: { paymentId: string; nonce: string; typedDataHash: string } | null;
  payment: { status: string; transactionHash: string | null } | null;
  delivery: { status: string; responseBody: unknown } | null;
  invoice: { status: string; invoiceNumber: string | null; lastError: string | null; buyerBusinessId?: string; costCenter?: string } | null;
  reconciliation: { status: string } | null;
  anchors: { kind: string; status: string; transactionHash: string | null; blockNumber: string | null }[];
  explorerLinks: { payment: string | null; anchor: string | null };
  availableActions: { retryInvoice: boolean; retryAnchor: boolean; reconcilePayment: boolean };
};
export type Task = {
  taskId: string; prompt: string; status: string; purchaseId: string | null; purchase: Purchase | null;
  intent: { targetCompanyName: string; maxAmount: { atomic: string; display: string }; usedDemoDefaultTarget: boolean } | null;
  candidates: Candidate[] | null; decisionSummary: string | null; error: { code: string; message: string | null } | null;
  timeline: AuditEvent[]; updatedAt: string; createdAt: string;
  control: { requestKey: string; approvalLimitAtomic: string | null; expectedPayTo: string | null;
    pendingTerms: { serviceId: string; amountAtomic: string; payTo: string } | null; approvedAt: string | null } | null;
};
export type TaskSummary = Pick<Task, "taskId" | "prompt" | "status" | "createdAt">;
