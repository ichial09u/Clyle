import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { jikan, type JikanAnime } from "@/lib/jikan";
import { anilistToJikan, homeFeed, mediaByMal, type AniListMedia } from "@/lib/anilist";
import { upsertAnime, upsertAniListMedia, lastSync } from "@/lib/sync";
import { lite, type AnimeLite, type HomePayload } from "@/lib/serialize";

export const dynamic = "force-dynamic";

interface TopList {
  data: JikanAnime[];
}

function dedup(items: AnimeLite[]): AnimeLite[] {
  const seen = new Set<number>();
  return items.filter((a) => (seen.has(a.malId) ? false : (seen.add(a.malId), true)));
}

/**
 * GET /api/home — the whole home screen.
 *
 * Primary source: AniList — ONE GraphQL request (~300ms warm-cache, ~1s cold)
 * returns trending + popular + airing + favorites + current season at once,
 * every entry carrying its MAL id for Zoko player URLs. AniList banners and
 * covers also come from its fast CDN, which is what makes hero cards snap in.
 *
 * Fallback: the original Jikan ranking calls (kept for MAL-only outages of
 * AniList), and finally the local catalog ordering.
 */
export async function GET() {
  // 1) make sure the catalog has details — fire-and-forget so the response
  //    stays fast; sparse rows heal over successive visits (via AniList).
  const sparse = await db.anime.findMany({
    where: { inCatalog: true, lastSyncedAt: null },
    select: { malId: true },
    take: 4,
  });
  if (sparse.length) {
    void (async () => {
      for (const s of sparse) {
        const media = await mediaByMal(s.malId);
        if (media) await upsertAniListMedia(media, { inCatalog: true, source: "seed" });
      }
    })().catch(() => undefined);
  }

  // 2) ONE AniList request for the full feed (disk-cached, stale-while-revalidate)
  const feed = await homeFeed();
  const toJ = (list: AniListMedia[] | undefined): JikanAnime[] =>
    (list ?? []).map(anilistToJikan).filter((a): a is JikanAnime => !!a);

  let top: JikanAnime[] = [];
  let popular: JikanAnime[] = [];
  let airing: JikanAnime[] = [];
  let favorite: JikanAnime[] = [];
  let season: JikanAnime[] = [];
  const popRank = new Map<number, number>(); // AniList popularity order -> MAL-style rank

  if (feed) {
    top = toJ(feed.popular); // "Most Popular" — global popularity ordering
    popular = toJ(feed.trending); // "Trending"
    airing = toJ(feed.airing);
    favorite = toJ(feed.favorite);
    season = toJ(feed.season);
    popular.forEach((a, i) => popRank.set(a.mal_id, i + 1));
  } else {
    // Fallback: MAL ranking lists (single attempt each — during MAL shed windows
    // the home screen falls back to catalog ordering below). A 6s cap keeps the
    // home screen responsive even if MAL is fully unreachable.
    const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T | null> =>
      Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
    const [t, p, a, f, s] = await Promise.all([
      withTimeout(jikan<TopList>("/top/anime?limit=25&sfw=true", { retries: 0, disk: true }), 6000),
      withTimeout(jikan<TopList>("/top/anime?filter=bypopularity&limit=25&sfw=true", { retries: 0, disk: true }), 6000),
      withTimeout(jikan<TopList>("/top/anime?filter=airing&limit=25&sfw=true", { retries: 0, disk: true }), 6000),
      withTimeout(jikan<TopList>("/top/anime?filter=favorite&limit=25&sfw=true", { retries: 0, disk: true }), 6000),
      withTimeout(jikan<TopList>("/seasons/now?limit=25&sfw=true", { retries: 0, disk: true }), 6000),
    ]);
    top = t?.data ?? [];
    popular = p?.data ?? [];
    airing = a?.data ?? [];
    favorite = f?.data ?? [];
    season = s?.data ?? [];
  }

  // 3) persist everything we saw (non-catalog rows are kept as import suggestions)
  const seenIds = new Set<number>();
  const all: JikanAnime[] = [];
  for (const a of [...top, ...popular, ...airing, ...favorite, ...season]) {
    if (seenIds.has(a.mal_id)) continue;
    seenIds.add(a.mal_id);
    all.push(a);
  }
  const catalogIds = new Set(
    (await db.anime.findMany({ where: { inCatalog: true }, select: { malId: true } })).map((r) => r.malId),
  );
  for (const a of all) {
    const ranked = popRank.get(a.mal_id);
    if (ranked) a.popularity = a.popularity ?? ranked; // keep MAL rank when we have one
    if (catalogIds.has(a.mal_id)) {
      await upsertAnime(a, { inCatalog: true, source: "seed" });
    } else {
      await upsertAnime(a, { inCatalog: false, source: "rankings" });
    }
  }

  // 4) build the home screen from catalog anime only ("only animes Zoko has")
  const rows = await db.anime.findMany({ where: { inCatalog: true } });
  const catalog = rows.map(lite);
  const byId = new Map(catalog.map((a) => [a.malId, a]));

  const pickFrom = (list: JikanAnime[] | undefined, n: number): AnimeLite[] =>
    dedup((list ?? []).map((a) => byId.get(a.mal_id)).filter((a): a is AnimeLite => !!a)).slice(0, n);

  const byPop = [...catalog].sort((a, b) => (a.popularity ?? 999999) - (b.popularity ?? 999999));
  const byScore = [...catalog].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const byAiring = catalog.filter((a) => a.airing).sort((a, b) => (a.popularity ?? 999999) - (b.popularity ?? 999999));
  const airingList = pickFrom(airing, 12).length ? pickFrom(airing, 12) : byAiring.slice(0, 12);

  const spotlight = airingList.length >= 4 ? airingList : byPop.slice(0, 12);
  const hero = dedup(spotlight).slice(0, 5);

  const trending = pickFrom(popular, 12);
  const mostPopular = pickFrom(top, 12);
  const mostFavorite = pickFrom(favorite, 12);

  const sections: HomePayload["sections"] = [
    { key: "spotlight", title: "Spotlight", items: spotlight },
    { key: "trending", title: "Trending", items: trending.length ? trending : byPop.slice(0, 12) },
    { key: "most-popular", title: "Most Popular", items: mostPopular.length ? mostPopular : byScore.slice(0, 12) },
    { key: "most-watched", title: "Most Watched", items: byPop.slice(0, 12) },
    { key: "top-airing", title: "Top Airing", items: airingList },
    { key: "most-favorite", title: "Most Favorite", items: mostFavorite.length ? mostFavorite : byScore.slice(0, 12) },
    { key: "new-episodes", title: "New Episodes", items: dedup(spotlight).slice(0, 12) },
  ];
  const top10 = byScore.slice(0, 10);

  const sync = await lastSync();
  const payload: HomePayload & { top10: AnimeLite[] } = {
    hero,
    sections,
    top10,
    lastSync: { at: sync.at },
  };
  return NextResponse.json(payload);
}
