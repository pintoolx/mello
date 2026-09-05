export const PENDING_REQUEST_KEY = "mello:pending-request";

export interface TaskInput {
  prompt: string;
  requestKey: string;
  approvalLimitAtomic?: string;
  expectedPayTo?: string;
  requirements?: { requiresTwInvoice: boolean; requiresRegistryCertification: boolean };
  attachmentIds?: string[];
}

export function atomicAmount(value: string): string {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value))
    throw new Error("金額請使用最多六位小數的 USDC 數字。");
  const [whole, fraction = ""] = value.split(".");
  return (
    BigInt(whole) * BigInt(1_000_000) +
    BigInt(fraction.padEnd(6, "0"))
  ).toString();
}

export function readPendingRequest(
  storage: Pick<Storage, "getItem">,
): TaskInput | null {
  const raw = storage.getItem(PENDING_REQUEST_KEY);
  if (!raw) return null;
  try {
    const input = JSON.parse(raw);
    if (
      typeof input?.prompt !== "string" ||
      !input.prompt.trim() ||
      typeof input.requestKey !== "string" ||
      input.requestKey.length < 16 ||
      input.requestKey.length > 128 ||
      (input.attachmentIds !== undefined &&
        (!Array.isArray(input.attachmentIds) || input.attachmentIds.length > 3 ||
          input.attachmentIds.some((id: unknown) => typeof id !== "string" || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(id)) ||
          new Set(input.attachmentIds).size !== input.attachmentIds.length)) ||
      (input.requirements !== undefined &&
        (typeof input.requirements?.requiresTwInvoice !== "boolean" ||
          typeof input.requirements?.requiresRegistryCertification !== "boolean")) ||
      (input.approvalLimitAtomic !== undefined &&
        (typeof input.approvalLimitAtomic !== "string" ||
          !/^\d{1,78}$/.test(input.approvalLimitAtomic))) ||
      (input.expectedPayTo !== undefined &&
        (typeof input.expectedPayTo !== "string" ||
          !/^0x[\da-fA-F]{40}$/.test(input.expectedPayTo)))
    )
      throw new Error("invalid");
    return {
      prompt: input.prompt,
      requestKey: input.requestKey,
      ...(input.attachmentIds !== undefined ? { attachmentIds: [...input.attachmentIds] } : {}),
      ...(input.requirements !== undefined ? { requirements: {
        requiresTwInvoice: input.requirements.requiresTwInvoice,
        requiresRegistryCertification: input.requirements.requiresRegistryCertification,
      } } : {}),
      ...(input.approvalLimitAtomic !== undefined
        ? { approvalLimitAtomic: input.approvalLimitAtomic }
        : {}),
      ...(input.expectedPayTo !== undefined
        ? { expectedPayTo: input.expectedPayTo }
        : {}),
    };
  } catch {
    throw new Error(
      "瀏覽器內有無法讀取的待確認申請。請先從採購清單核對，交由管理員協助；系統不會自動另建付款。",
    );
  }
}
