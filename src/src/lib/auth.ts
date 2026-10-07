import "server-only";

import crypto from "node:crypto";

/**
 * Google sign-in for Clyle — zero-dependency OAuth 2.0 + signed session
 * cookie. No passwords: a Google account maps 1:1 onto a User row
 * (id = "google:<sub>"), and the player's progress heartbeats already write
 * WatchProgress keyed by that id, so signed-in viewers keep their progress
 * across every device they sign in on.
 *
 * Owner setup (one time):
 *   1. console.cloud.google.com → APIs & Services → OAuth consent screen
 *      (External) → Credentials → "Create credentials → OAuth client ID"
 *      → Application type: Web application
 *   2. Authorized redirect URI:
 *        https://temporary-spry-granite-1f0h7ae.vercel.app/api/auth/google/callback
 *      (add http://localhost:3000/api/auth/google/callback for local dev)
 *   3. Add the env vars to the Vercel project:
 *        GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
 * Until then every auth route degrades gracefully (configured: false) and
 * the app keeps working with the anonymous local identity.
 */

export const SESSION_COOKIE = "clyle_session";
export const OAUTH_STATE_COOKIE = "clyle_oauth_state";
const SESSION_TTL_S = 60 * 60 * 24 * 30; // 30 days
const STATE_TTL_S = 600; // 10 minutes

interface SessionPayload {
  /** Clyle user id — "google:<sub>" */
  uid: string;
  nickname: string;
  email: string | null;
  avatar: string | null;
  /** issued-at (epoch seconds) */
  iat: number;
  /** expiry (epoch seconds) */
  exp: number;
}

export interface SessionUser {
  id: string;
  nickname: string;
  email: string | null;
  avatar: string | null;
}

export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function secret(): string {
  return process.env.AUTH_SECRET || process.env.GOOGLE_CLIENT_SECRET || "clyle-dev-only-secret";
}

const b64url = (buf: Buffer | string) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function hmac(data: string): string {
  return crypto.createHmac("sha256", secret()).update(data).digest("base64url");
}

/** Sign a session payload into a compact tamper-proof cookie value. */
export function signSession(user: SessionUser): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    uid: user.id,
    nickname: user.nickname,
    email: user.email,
    avatar: user.avatar,
    iat: now,
    exp: now + SESSION_TTL_S,
  };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${hmac(body)}`;
}

/** Verify the cookie value; null when tampered/expired. */
export function verifySession(token: string | undefined | null): SessionUser | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64").toString("utf8")) as SessionPayload;
    if (!payload?.uid || payload.exp * 1000 < Date.now()) return null;
    return { id: payload.uid, nickname: payload.nickname, email: payload.email, avatar: payload.avatar };
  } catch {
    return null;
  }
}

/** Read the signed-in viewer from the request's cookies (or null). */
export function sessionFromRequest(req: Request): SessionUser | null {
  const cookie = req.headers.get("cookie") ?? "";
  const raw = cookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!raw) return null;
  return verifySession(decodeURIComponent(raw.slice(SESSION_COOKIE.length + 1)));
}

export function sessionCookieOptions(maxAge = SESSION_TTL_S) {
  return {
    name: SESSION_COOKIE,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

/** CSRF state for the OAuth round trip. */
export function newOAuthState(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function stateCookieValue(state: string): string {
  return `${state}.${hmac(state)}`;
}

export function stateCookieValid(cookieVal: string | undefined, queryState: string | null): boolean {
  if (!cookieVal || !queryState) return false;
  const dot = cookieVal.lastIndexOf(".");
  if (dot <= 0) return false;
  const state = cookieVal.slice(0, dot);
  const sig = cookieVal.slice(dot + 1);
  const a = Buffer.from(sig);
  const b = Buffer.from(hmac(state));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return state === queryState;
}

/** The Google OAuth authorize URL for this deployment. */
export function googleAuthUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export interface GoogleProfile {
  sub: string;
  email: string | null;
  name: string | null;
  picture: string | null;
}

/** Exchange the ?code for tokens and read the Google profile out of id_token. */
export async function exchangeGoogleCode(
  code: string,
  redirectUri: string,
): Promise<GoogleProfile | null> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) return null;
  const tokens = (await res.json()) as { id_token?: string };
  if (!tokens.id_token) return null;
  // the id_token comes straight from Google's token endpoint over TLS —
  // decoding the payload (no JWK round-trip) is the documented shortcut
  const payloadB64 = tokens.id_token.split(".")[1];
  if (!payloadB64) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8")) as GoogleProfile & { exp?: number };
    if (!payload.sub || (payload.exp ?? 0) * 1000 < Date.now()) return null;
    return { sub: payload.sub, email: payload.email ?? null, name: payload.name ?? null, picture: payload.picture ?? null };
  } catch {
    return null;
  }
}

/** Serialize a Set-Cookie header line for our session/state cookies. */
export function cookieLine(
  name: string,
  value: string,
  opts: { maxAge: number; httpOnly?: boolean; path?: string },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path ?? "/"}`,
    `Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`,
  ];
  if (opts.httpOnly !== false) parts.push("HttpOnly=true");
  parts.push("SameSite=Lax");
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

/** Set-Cookie line that deletes a cookie (sign-out / consumed state). */
export function clearCookieLine(name: string): string {
  return cookieLine(name, "", { maxAge: 0 });
}
