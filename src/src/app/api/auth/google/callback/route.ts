import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  clearCookieLine,
  cookieLine,
  exchangeGoogleCode,
  googleConfigured,
  sessionCookieOptions,
  signSession,
  stateCookieValid,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/google/callback — Google redirects here with ?code=&state=.
 *
 *  1. the signed state cookie must match ?state= (CSRF)
 *  2. exchange the code for tokens, read the profile out of id_token
 *  3. upsert the User row (id = "google:<sub>" — 1:1 with the Google account)
 *  4. set the signed session cookie (30 days) and land back on the app
 *
 * Every failure lands on /signin?error=<reason> with an honest message.
 * The state cookie is consumed either way.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const sp = url.searchParams;
  const back = (err: string) =>
    new NextResponse(null, {
      status: 302,
      headers: {
        Location: `/signin?error=${encodeURIComponent(err)}`,
        "Cache-Control": "no-store",
        "Set-Cookie": clearCookieLine(OAUTH_STATE_COOKIE),
      },
    });

  if (!googleConfigured()) return back("not_configured");

  const err = sp.get("error");
  if (err) return back(err === "access_denied" ? "denied" : err);

  const code = sp.get("code");
  const state = sp.get("state");
  if (!code || !state) return back("missing_code");

  const cookie = req.headers.get("cookie") ?? "";
  const rawState = cookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=`))
    ?.slice(OAUTH_STATE_COOKIE.length + 1);
  if (!stateCookieValid(rawState ? decodeURIComponent(rawState) : undefined, state)) return back("bad_state");

  const profile = await exchangeGoogleCode(code, `${url.origin}/api/auth/google/callback`);
  if (!profile) return back("exchange_failed");

  const uid = `google:${profile.sub}`;
  const nickname = (profile.name ?? profile.email ?? "Username").slice(0, 24) || "Username";
  const avatar = profile.picture && profile.picture.length <= 2000 ? profile.picture : null;
  await db.user.upsert({
    where: { id: uid },
    update: { nickname, avatar: avatar ?? undefined },
    create: { id: uid, nickname, avatar },
  });

  const session = signSession({ id: uid, nickname, email: profile.email, avatar });
  return new NextResponse(null, {
    status: 302,
    headers: {
      Location: "/?signedin=1",
      "Cache-Control": "no-store",
      "Set-Cookie": [
        cookieLine(SESSION_COOKIE, session, { maxAge: sessionCookieOptions().maxAge, httpOnly: true }),
        clearCookieLine(OAUTH_STATE_COOKIE),
      ].join(", "),
    },
  });
}
