import { NextResponse } from "next/server";
import { cookieLine, googleAuthUrl, googleConfigured, newOAuthState, OAUTH_STATE_COOKIE, stateCookieValue } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/google — begin the sign-in round trip.
 *
 * Not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing) → 503 with
 * configured:false so the sign-in page can explain itself. Configured → 302
 * to Google with a signed CSRF state cookie.
 */
export async function GET(req: Request) {
  if (!googleConfigured()) {
    return NextResponse.json(
      { error: "Google sign-in is not configured yet", configured: false },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const origin = new URL(req.url).origin;
  const state = newOAuthState();
  const authUrl = googleAuthUrl(`${origin}/api/auth/google/callback`, state);

  return new NextResponse(null, {
    status: 302,
    headers: {
      Location: authUrl,
      "Cache-Control": "no-store",
      "Set-Cookie": cookieLine(OAUTH_STATE_COOKIE, stateCookieValue(state), { maxAge: 600, httpOnly: true }),
    },
  });
}
