import { NextResponse } from "next/server";
import { SESSION_COOKIE, clearCookieLine } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/signout — clear the session cookie. POST-only so a stray
 * <img> or prefetch can't sign anyone out; the client also restores the
 * device's anonymous identity (see lib/account.ts).
 */
export async function POST() {
  return NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store", "Set-Cookie": clearCookieLine(SESSION_COOKIE) } },
  );
}
