import { NextRequest, NextResponse } from "next/server";
import { hasSession, sameOrigin } from "@/lib/server-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const UUID = "[0-9a-fA-F-]{36}";
const READ = new RegExp(`^(settings|company|policies/active|controls|demo/health|dashboard/summary|services|sellers|registry(?:/discovery)?|audit-events|tasks|purchases|tasks/${UUID}(?:/events)?|purchases/${UUID}(?:/events)?)$`);
const WRITE = new RegExp(`^(tasks|tasks/${UUID}/(?:discover|select|run|approve|retry-invoice|retry-anchor|reconcile-payment)|purchases/${UUID}/(?:retry-invoice|retry-anchor|reconcile-payment))$`);

async function proxy(request: NextRequest, context: Context) {
  const fail = (status: number, message: string) => NextResponse.json({ error: { message } }, { status, headers: { "cache-control": "no-store" } });
  if (!hasSession(request)) return fail(401, "請先登入操作台");
  if (request.method !== "GET" && !sameOrigin(request)) return fail(403, "跨來源操作已拒絕");
  const path = (await context.params).path.join("/");
  const allowed = request.method === "GET" ? READ.test(path) : request.method === "POST" ? WRITE.test(path) : /^(company|policies\/active|controls)$/.test(path);
  if (!allowed) return fail(404, "此操作不開放於線上操作台");
  const base = process.env.CORE_API_URL;
  const apiKey = process.env.API_ACCESS_TOKEN;
  const adminKey = process.env.DEMO_ADMIN_TOKEN;
  if (!base || !apiKey || !adminKey) return fail(503, "後端連線尚未設定");
  try {
    const body = request.method === "GET" ? undefined : await request.text();
    if (body && Buffer.byteLength(body) > 64 * 1024) return fail(413, "請求內容過長");
    const headers: Record<string, string> = { "content-type": "application/json", "x-mello-api-key": apiKey };
    if (request.method === "PUT" || /\/(approve|reconcile-payment)$/.test(path)) headers["x-demo-admin-token"] = adminKey;
    const upstream = await fetch(new URL(`/api/v1/${path}${request.nextUrl.search}`, base), {
      method: request.method, headers, body: body || undefined, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    if (!upstream.headers.get("content-type")?.includes("application/json")) return fail(502, "後端回應格式異常，請稍後重新整理狀態");
    return NextResponse.json(await upstream.json(), { status: upstream.status,
      headers: { "cache-control": "no-store", "x-request-id": upstream.headers.get("x-request-id") ?? "" } });
  } catch { return fail(502, "暫時無法連線後端；付款可能仍在處理，請重新整理既有任務，勿重複建立採購"); }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
