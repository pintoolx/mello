export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly requestId?: string) { super(message); }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, cache: "no-store", credentials: "same-origin",
    headers: { "content-type": "application/json", ...init.headers }, signal: init.signal ?? AbortSignal.timeout(35_000) });
  const body = await response.json();
  if (!response.ok) throw new ApiError(body?.error?.message ?? "無法完成操作，請重新整理狀態", response.status, body?.error?.requestId);
  return body as T;
}

export function formatAmount(value?: string | null) {
  if (!value || !/^\d+$/.test(value)) return "—";
  const amount = BigInt(value);
  const scale = BigInt(1_000_000);
  return `${amount / scale}.${(amount % scale).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0")}`;
}

export function shortId(value?: string | null) { return value ? `${value.slice(0, 8)}…${value.slice(-6)}` : "—"; }
export function displayTime(value?: string | null) {
  return value ? new Date(value).toLocaleString("zh-TW", { hour12: false }) : "—";
}
