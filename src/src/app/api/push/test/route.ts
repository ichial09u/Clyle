import { NextResponse } from "next/server";
import { sendTestPush } from "@/lib/push";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/push/test — broadcast a confirmation notification to every
 * subscribed browser ("Clyle push works 🎉"). Used by the opt-in toggle
 * (instant proof the pipe is alive) and by smoke/verification.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const quiet = url.searchParams.get("quiet") === "1";
  const r = await sendTestPush(quiet);
  return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
}
