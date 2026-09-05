import "server-only";
import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { NextRequest } from "next/server";

export const SESSION_COOKIE = "mello_session";
export const SESSION_MAX_AGE = 12 * 60 * 60;

export function sessionConfigured() {
  return (process.env.MELLO_ACCESS_CODE?.length ?? 0) >= 16 && (process.env.MELLO_SESSION_SECRET?.length ?? 0) >= 32;
}

export function sameOrigin(request: NextRequest) {
  const expected = process.env.WEB_PUBLIC_URL ? new URL(process.env.WEB_PUBLIC_URL).origin : request.nextUrl.origin;
  return request.headers.get("origin") === expected;
}

export function accessCodeMatches(code: string) {
  if (!sessionConfigured()) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(code), digest(process.env.MELLO_ACCESS_CODE!));
}

function sign(payload: string) {
  return createHmac("sha256", process.env.MELLO_SESSION_SECRET!).update(payload).digest("base64url");
}

export function createSession() {
  if (!sessionConfigured()) throw new Error("Demo session is not configured");
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_MAX_AGE * 1000, nonce: randomBytes(16).toString("hex") })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function hasSession(request: NextRequest) {
  if (!sessionConfigured()) return false;
  const token = request.cookies.get(SESSION_COOKIE)?.value ?? "";
  if (token.length > 1024) return false;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return false;
  const expected = sign(payload);
  if (Buffer.byteLength(signature) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof data.exp === "number" && data.exp > Date.now() && data.exp <= Date.now() + SESSION_MAX_AGE * 1000;
  } catch { return false; }
}

export function sessionCookieOptions() {
  return { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict" as const, path: "/", maxAge: SESSION_MAX_AGE };
}
