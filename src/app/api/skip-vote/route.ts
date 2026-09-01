import { NextResponse } from "next/server";
import { recordSkipVote } from "@/lib/skip-times";

export const dynamic = "force-dynamic";

/**
 * POST /api/skip-vote  { malId, ep, target }
 *
 * Crowd-learned Skip Intro: a viewer manually scrubbing forward past the
 * opening is the strongest signal we get about where that OP ends when no
 * skip data exists anywhere (brand-new seasons). The median of these votes
 * becomes the Skip Intro target for EVERY viewer of that show.
 *
 * Validated + capped server-side (catalog member, 30-420s, 200 rows/anime);
 * answers { ok } so a logging failure never disturbs playback.
 */
export async function POST(req: Request) {
  let b: { malId?: unknown; ep?: unknown; target?: unknown };
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const malId = Number(b.malId);
  const ep = Number(b.ep);
  const target = Number(b.target);
  const ok = await recordSkipVote(malId, ep, target);
  return NextResponse.json({ ok }, { headers: { "Cache-Control": "no-store" } });
}
