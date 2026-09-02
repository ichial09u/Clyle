import { NextResponse } from "next/server";
import { getTop10Month } from "@/lib/top10-month";
import { lite } from "@/lib/serialize";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // cold start = one live TMDB pass

/**
 * GET /api/top10 — "Top 10 This Month".
 *
 * Catalog titles ranked by TMDB's anime popularity order (see
 * src/lib/top10-month.ts). The ranking is ACTIVE: every refresh re-reads
 * TMDB, so when a title's popularity passes the one above it, the two swap
 * ranks; each swap / drop / new entry also records a bell notification.
 *
 * Response: { day, items: [{ ...AnimeLite, rank, prevRank }] }
 *   prevRank = the rank before the most recent change (null = new entry),
 *   powering the up / down / NEW badges on the rail.
 */
export async function GET() {
  const items = await getTop10Month();
  const ids = items.map((i) => i.malId);
  let rows: Awaited<ReturnType<typeof db.anime.findMany>> = [];
  try {
    rows = ids.length
      ? await db.anime.findMany({ where: { malId: { in: ids } } })
      : [];
  } catch {
    rows = [];
  }
  const cat = new Map(rows.map((a) => [a.malId, lite(a)]));

  const out = items.map((i) => {
    const l = cat.get(i.malId);
    return {
      ...(l ?? {
        malId: i.malId,
        title: i.title,
        titleEnglish: null,
        image: i.image,
        banner: null,
        synopsis: null,
        type: null,
        ratingShort: null,
        status: null,
        airing: false,
        season: null,
        year: null,
        durationMin: null,
        score: null,
        rank: null,
        popularity: null,
        totalEpisodes: 0,
        genres: [],
        inCatalog: false,
        source: "snapshot",
      }),
      rank: i.rank,
      prevRank: i.prevRank,
    };
  });

  return NextResponse.json(
    { day: new Date().toISOString().slice(0, 10), items: out },
    { headers: { "Cache-Control": "no-store" } },
  );
}
