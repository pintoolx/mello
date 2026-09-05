import { sanitizedErrorMessage } from "@mello/shared";

export const TERMINAL_TASK_STATUSES = new Set([
  "COMPLETED",
  "REJECTED",
  "ACTION_REQUIRED",
  "FAILED",
]);

export function apiBaseUrl(): string {
  return (process.env["CORE_API_URL"] ?? "http://localhost:4000")
    .replace(/\/$/, "");
}

export function asRecord(value: unknown, label = "response"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

export function requiredString(
  record: Record<string, unknown>,
  key: string,
  label = key,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is missing`);
  }
  return value;
}

export async function requestJson(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)),
      ...(process.env["API_ACCESS_TOKEN"] ? { "x-mello-api-key": process.env["API_ACCESS_TOKEN"] } : {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body: unknown = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    const object = body && typeof body === "object" ? body as Record<string, unknown> : null;
    const error = object?.["error"];
    const message =
      error && typeof error === "object" && "message" in error
        ? String(error.message)
        : `HTTP ${response.status}`;
    throw new Error(`${init.method ?? "GET"} ${path} failed: ${message}`);
  }
  return { status: response.status, body };
}

export async function createAndRunTask(prompt: string): Promise<Record<string, unknown>> {
  const created = asRecord(
    (
      await requestJson("/api/v1/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt }),
      })
    ).body,
    "create task response",
  );
  const taskId = requiredString(created, "taskId");
  await requestJson(`/api/v1/tasks/${taskId}/run`, { method: "POST" });
  return pollTask(taskId);
}

export async function pollTask(
  taskId: string,
  timeoutMs = 90_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = asRecord(
      (await requestJson(`/api/v1/tasks/${taskId}`)).body,
      "task detail",
    );
    const status = requiredString(task, "status");
    if (TERMINAL_TASK_STATUSES.has(status)) return task;
    await new Promise<void>((resolve) => setTimeout(resolve, 350));
  }
  throw new Error(`Task ${taskId} did not finish within ${timeoutMs} ms`);
}

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function safeErrorMessage(error: unknown): string {
  return sanitizedErrorMessage(error, "Unknown failure");
}
