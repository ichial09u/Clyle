import { NextResponse } from "next/server";
import { runAnnNewsSweep } from "@/lib/ann-news";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * ANN News sweep — the daily Vercel cron trigger (Hobby plans only allow
 * daily crons; organic home traffic kicks the same sweep hourly via
 * /api/home + after()). The logic lives in lib/ann-news.ts.
 *
 * GET /api/ann-news  (also safe to call manually for a status report)
 */
export async function GET() {
  // runAnnNewsSweep carries its own 60-min claim + full try/catch, so a manual
  // call can no longer (a) bypass the throttle to force RSS hammering or
  // (b) surface a raw 500 from a mid-sweep DB failure
  const report = await runAnnNewsSweep();
  return NextResponse.json({ ...report, at: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
}
