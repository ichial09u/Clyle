import { NextResponse } from "next/server";
import { googleConfigured, sessionFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/me — the client's session probe.
 * { configured, user } — user is the Google identity or null (anonymous).
 */
export async function GET(req: Request) {
  const user = sessionFromRequest(req);
  return NextResponse.json(
    { configured: googleConfigured(), user },
    { headers: { "Cache-Control": "no-store" } },
  );
}
