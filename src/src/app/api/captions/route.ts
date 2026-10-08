import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/captions?malId=3588&ep=5&lang=dub
 *
 * CC-sync fleet verdict for one episode: how far the provider's caption
 * track lags (or leads) the dub audio, measured by the cc-sync fleet bots
 * (ASR-align transcript to cue text, median across sampled cues).
 *
 *   offsetMs > 0  captions appear LATE — the player shifts cues earlier
 *   offsetMs < 0  captions appear EARLY — the player shifts cues later
 *   driftMsPerMin LINEAR drift term: captions gain this many ms per playback
 *                 minute (the player remaps cue times with it — this is what
 *                 fixes skew that GROWS through the episode)
 *   fitR2         0-1 quality of the linear fit across measurement windows
 *   measured:false  no fleet verdict yet — player plays captions untouched
 *
 * The player applies the shift only when |offsetMs| >= 250 (below that the
 * misalignment is imperceptible) or a significant linear drift was fitted,
 * and confidence >= 0.4.
 */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const malId = parseInt(sp.get("malId") ?? "", 10);
  const ep = parseInt(sp.get("ep") ?? "", 10);
  const lang = sp.get("lang") === "sub" ? "sub" : "dub";
  if (!Number.isFinite(malId) || !Number.isFinite(ep)) {
    return NextResponse.json({ ok: false, measured: false, offsetMs: 0 });
  }
  try {
    const row = await db.captionSync.findUnique({
      where: { malId_ep_lang: { malId, ep, lang } },
    });
    if (!row) return NextResponse.json({ ok: true, measured: false, offsetMs: 0 });
    return NextResponse.json({
      ok: true,
      measured: true,
      offsetMs: row.offsetMs,
      driftMsPerMin: row.driftMsPerMin,
      fitR2: row.fitR2,
      confidence: row.confidence,
      samples: row.samples,
      attempted: row.attempted,
      spreadMs: row.spreadMs,
      server: row.server,
      checkedAt: row.checkedAt,
    });
  } catch {
    return NextResponse.json({ ok: false, measured: false, offsetMs: 0 });
  }
}
