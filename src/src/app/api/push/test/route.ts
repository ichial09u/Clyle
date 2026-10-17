import { NextResponse } from "next/server";
import { isOwnerRequest } from "@/lib/guard";
import { sendTestPush } from "@/lib/push";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/push/test — broadcast a confirmation notification to every
 * subscribed browser ("Clyle push works 🎉"). Owner-gated: unauthenticated it
 * let anyone ring every subscriber's device (and burn the WebPush budget) in
 * a curl loop — no client surface calls this route, only owner smoke checks.
 */
export async function POST(req: Request) {
  if (!isOwnerRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const url = new URL(req.url);
  const quiet = url.searchParams.get("quiet") === "1";
  const r = await sendTestPush(quiet);
  return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
}
