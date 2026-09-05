import { NextRequest, NextResponse } from "next/server";
import { accessCodeMatches, createSession, hasSession, sameOrigin, SESSION_COOKIE, sessionConfigured, sessionCookieOptions } from "@/lib/server-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
let loginWindow = { startedAt: Date.now(), attempts: 0 };

export async function GET(request: NextRequest) {
  return NextResponse.json({ authenticated: hasSession(request), configured: sessionConfigured() }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: { message: "請從本站登入" } }, { status: 403 });
  if (!sessionConfigured()) return NextResponse.json({ error: { message: "管理員尚未設定登入環境" } }, { status: 503 });
  if (Date.now() - loginWindow.startedAt > 60_000) loginWindow = { startedAt: Date.now(), attempts: 0 };
  if (++loginWindow.attempts > 30) return NextResponse.json({ error: { message: "登入嘗試過多，請一分鐘後再試" } }, { status: 429 });
  try {
    const text = await request.text();
    if (text.length > 1024) return NextResponse.json({ error: { message: "登入資料過長" } }, { status: 413 });
    const { code } = JSON.parse(text);
    if (typeof code !== "string" || !accessCodeMatches(code)) return NextResponse.json({ error: { message: "存取碼不正確" } }, { status: 401 });
    const response = NextResponse.json({ authenticated: true }, { headers: { "cache-control": "no-store" } });
    response.cookies.set(SESSION_COOKIE, createSession(), sessionCookieOptions());
    return response;
  } catch { return NextResponse.json({ error: { message: "登入資料格式不正確" } }, { status: 400 }); }
}

export async function DELETE(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: { message: "跨來源請求已拒絕" } }, { status: 403 });
  const response = NextResponse.json({ authenticated: false });
  response.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
  return response;
}
