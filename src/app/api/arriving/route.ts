import { NextResponse, after } from "next/server";
import { getArriving, refreshArriving } from "@/lib/arriving";
import { lite } from "@/lib/serialize";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/arriving — the Netflix-style "Arriving" rail.
 *
 * Every scheduled drop for the next 3 weeks (AniList's airing schedule merged
 * with the catalog's own next-episode times), each tagged the Netflix way:
 * NEW SERIES / NEW MOVIE / EP n, with the exact air time for the countdown.
 *
 * The last known list answers instantly; the live re-check is scheduled with
 * after() so it keeps running after this response is sent (a bare floating
 * promise gets frozen on Vercel serverless — the same lesson /api/top10
 * learned the hard way):
 *   - "?fresh=1" (sent by the client on app open / PWA foreground return)
 *     forces a live pass past the 30 min TTL — floored to one per minute.
 *   - otherwise a stale snapshot schedules a TTL-gated pass.
 *
 * Response: { day, items: [{ ...AnimeLite, kind, episode, airingAt }] }
 *   AnimeLite is fully hydrated for catalog titles (click-through works
 *   everywhere); non-catalog premieres carry a minimal lite built from the
 *   AniList schedule — DetailsView imports them on demand when tapped.
 */
export async function GET(req: Request) {
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  const { items, stale, hasSnapshot } = await getArriving();

  if (hasSnapshot) {
    if (fresh) after(() => refreshArriving(true).catch(() => undefined));
    else if (stale) after(() => refreshArriving().catch(() => undefined));
  }

  let rows: Awaited<ReturnType<typeof db.anime.findMany>> = [];
  try {
    rows = items.length
      ? await db.anime.findMany({ where: { malId: { in: items.map((i) => i.malId) } } })
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
        type: i.kind === "movie" ? "Movie" : null,
        ratingShort: null,
        status: "Not yet aired",
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
        source: "arriving",
      }),
      kind: i.kind,
      episode: i.episode,
      airingAt: i.airingAt,
    };
  });

  return NextResponse.json(
    { day: new Date().toISOString().slice(0, 10), items: out },
    { headers: { "Cache-Control": "no-store" } },
  );
}
