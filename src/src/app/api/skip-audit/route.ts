import { NextResponse } from "next/server";
import { runSkipAudit } from "@/lib/skip-audit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/skip-audit — verify the Skip Intro button will appear across the
 * WHOLE catalog (every anime, first/middle/latest episode sampled).
 *
 *   /api/skip-audit          → local coverage report (fast)
 *   /api/skip-audit?probe=1  → also ask AniSkip live for gaps + cache them
 *
 * `ok: true` means every sampled TV episode shows a Skip Intro button
 * (movies/specials are exempt by design — we never blind-skip inside a film).
 */
export async function GET(req: Request) {
  const probe = new URL(req.url).searchParams.get("probe") === "1";
  try {
    const report = await runSkipAudit(probe);
    return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: String(err).slice(0, 300) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
