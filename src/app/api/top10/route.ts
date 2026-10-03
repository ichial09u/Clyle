import { NextResponse, after } from "next/server";
import { getTop10Month, refreshTop10Month } from "@/lib/top10-month";
import { lite } from "@/lib/serialize";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // cold start = one live Anime Trending pass

/**
 * GET /api/top10 — "Top 10 This Month".
 *
 * Catalog titles ranked by Anime Trending's community-voted "Top Anime"
 * chart (see src/lib/top10-month.ts). The ranking is ACTIVE: every refresh
 * re-reads the live chart, so when a title's standing passes the one above
 * it, the two swap ranks; each swap / drop / new entry also records a bell
 * notification.
 *
 * The last known list answers instantly; the live re-check is scheduled with
 * after() so it keeps running after this response is sent — a bare floating
 * promise gets frozen on Vercel serverless, which is why the rail used to go
 * stale between daily crons:
 *   - "?fresh=1" (sent by the client on EVERY app open / PWA foreground
 *     return) forces a live pass past the 2h TTL — floored to one per minute
 *     inside refreshTop10Month, so rapid reopens stay cheap.
 *   - otherwise a stale snapshot schedules a TTL-gated pass.
 *
 * Response: { day, items: [{ ...AnimeLite, rank, prevRank }] }
 *   prevRank = the rank before the most recent change (null = new entry),
 *   powering the up / down / NEW badges on the rail.
 */
export async function GET(req: Request) {
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  const { items, stale, hasSnapshot } = await getTop10Month();

  if (hasSnapshot) {
    if (fresh) after(() => refreshTop10Month(true).catch(() => undefined));
    else if (stale) after(() => refreshTop10Month().catch(() => undefined));
  }

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
