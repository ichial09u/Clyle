import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { jikan, jikanOne, type JikanAnime } from "@/lib/jikan";
import { upsertAnime, lastSync } from "@/lib/sync";
import { lite, type AnimeLite, type HomePayload } from "@/lib/serialize";

export const dynamic = "force-dynamic";

interface TopList {
  data: JikanAnime[];
}

function dedup(items: AnimeLite[]): AnimeLite[] {
  const seen = new Set<number>();
  return items.filter((a) => (seen.has(a.malId) ? false : (seen.add(a.malId), true)));
}

export async function GET() {
  // 1) make sure the catalog has details — fire-and-forget so the response stays fast;
  //    sparse rows heal over successive visits.
  const sparse = await db.anime.findMany({
    where: { inCatalog: true, lastSyncedAt: null },
    select: { malId: true },
    take: 4,
  });
  if (sparse.length) {
    void (async () => {
      for (const s of sparse) {
        const full = await jikanOne<JikanAnime>(`/anime/${s.malId}/full`);
        if (full) await upsertAnime(full, { inCatalog: true, source: "seed" });
      }
    })().catch(() => undefined);
  }

  // 2) pull the MAL ranking lists (single attempt each — during MAL shed windows
  //    the home screen falls back to catalog ordering below; lists refresh quietly).
  //    A 6s cap keeps the home screen responsive even if MAL is fully unreachable.
  const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T | null> =>
    Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
  const [top, popular, airing, favorite, season] = await Promise.all([
    withTimeout(jikan<TopList>("/top/anime?limit=25&sfw=true", { retries: 0, disk: true }), 6000),
    withTimeout(jikan<TopList>("/top/anime?filter=bypopularity&limit=25&sfw=true", { retries: 0, disk: true }), 6000),
    withTimeout(jikan<TopList>("/top/anime?filter=airing&limit=25&sfw=true", { retries: 0, disk: true }), 6000),
    withTimeout(jikan<TopList>("/top/anime?filter=favorite&limit=25&sfw=true", { retries: 0, disk: true }), 6000),
    withTimeout(jikan<TopList>("/seasons/now?limit=25&sfw=true", { retries: 0, disk: true }), 6000),
  ]);

  // 3) persist everything we saw (non-catalog rows are kept as import suggestions)
  const all = [...(top?.data ?? []), ...(popular?.data ?? []), ...(airing?.data ?? []), ...(favorite?.data ?? []), ...(season?.data ?? [])];
  const catalogIds = new Set(
    (await db.anime.findMany({ where: { inCatalog: true }, select: { malId: true } })).map((r) => r.malId),
  );
  const seenIds = new Set<number>();
  for (const a of all) {
    if (seenIds.has(a.mal_id)) continue;
    seenIds.add(a.mal_id);
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
  const airingList = pickFrom(airing?.data, 12).length ? pickFrom(airing?.data, 12) : byAiring.slice(0, 12);

  const spotlight = airingList.length >= 4 ? airingList : byPop.slice(0, 12);
  const hero = dedup(spotlight).slice(0, 5);

  const trending = pickFrom(popular?.data, 12);
  const mostPopular = pickFrom(top?.data, 12);
  const mostFavorite = pickFrom(favorite?.data, 12);

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
