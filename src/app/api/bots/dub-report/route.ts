import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/bots/dub-report?token=T
 *
 * The fleet's "which anime still require dub" list — what the bots fetch and
 * log after each sweep. Three buckets, precise per episode:
 *
 *   noDubAtAll    — no real English dub on ANY source (Zoko/Kiwi probed
 *                   fake-or-missing, Megaplay backfill absent, megaplay-embed
 *                   /SupaPlay backfills unmapped-or-absent). Sub-only today;
 *                   the app shows no DUB buttons for these.
 *   dubBehind     — a real dub EXISTS but hasn't reached the latest episodes
 *                   (One Piece/Elbaph: dubbed through ~ep N of 1176). The
 *                   per-episode boundary (dubThruS1/S2) keeps DUB buttons
 *                   off the undubbed tail.
 *   unprobed      — a dub may exist but the per-episode boundary hasn't been
 *                   measured yet (the fleet's binary search hasn't reached
 *                   them) — the queue that keeps the boundary search fed.
 */
const TOKEN = process.env.SCOUT_TOKEN ?? "clyle-scout-v1";

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  if (sp.get("token") !== TOKEN) return NextResponse.json({ error: "bad token" }, { status: 401 });

  try {
    const animes = await db.anime.findMany({
      where: { inCatalog: true },
      select: {
        malId: true, title: true, titleEnglish: true, airing: true,
        popularity: true, totalEpisodes: true,
        hasDub: true, hasDubKiwi: true, hasDubMega: true,
        dubThruS1: true, dubThruS2: true,
        supaplayPath: true, anikotoSeriesId: true,
      },
      orderBy: { popularity: "asc" },
    });

    const noDubAtAll: Array<Record<string, unknown>> = [];
    const dubBehind: Array<Record<string, unknown>> = [];
    const unprobed: Array<Record<string, unknown>> = [];

    for (const a of animes) {
      const label = a.titleEnglish?.trim() || a.title;
      const base = { malId: a.malId, title: label, airing: a.airing, total: a.totalEpisodes };
      const anyProbedFalse = a.hasDub === false || a.hasDubKiwi === false;
      const anyDubTrue = a.hasDub === true || a.hasDubKiwi === true || a.hasDubMega === true;
      // a backfill mapping (SupaPlay path / AniKoto series) means the dub can
      // be served even when every anime-level verdict is false — such an
      // anime is never "sub-only"; its boundary decides (JJK S2 case)
      const backfillMapped = !!a.supaplayPath?.trim() || a.anikotoSeriesId != null;

      if (a.hasDub === false && a.hasDubKiwi === false && a.hasDubMega !== true && !backfillMapped) {
        noDubAtAll.push(base); // definitively sub-only across every source
        continue;
      }
      if (anyDubTrue || backfillMapped) {
        const thru = Math.max(a.dubThruS1 ?? 0, a.dubThruS2 ?? 0);
        if (a.dubThruS1 == null && a.dubThruS2 == null) {
          unprobed.push({ ...base, hasDub: a.hasDub, hasDubKiwi: a.hasDubKiwi, hasDubMega: a.hasDubMega, backfillMapped });
        } else if (thru < a.totalEpisodes) {
          dubBehind.push({ ...base, dubThrough: thru, episodesMissingDub: Math.max(0, a.totalEpisodes - thru) });
        } // thru >= total AND mapped: fully dubbed via backfill — no bucket
        continue;
      }
      if (anyProbedFalse) continue; // covered by noDubAtAll above
      unprobed.push({ ...base, hasDub: a.hasDub, hasDubKiwi: a.hasDubKiwi, hasDubMega: a.hasDubMega });
    }

    return NextResponse.json(
      {
        ok: true,
        generatedAt: new Date().toISOString(),
        totals: {
          anime: animes.length,
          noDubAtAll: noDubAtAll.length,
          dubBehind: dubBehind.length,
          unprobed: unprobed.length,
        },
        // the headline list the bots log: shows still waiting for dub episodes
        stillRequiringDub: dubBehind,
        noDubAtAll,
        unprobed: unprobed.slice(0, 400),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err).slice(0, 300) }, { status: 500 });
  }
}
