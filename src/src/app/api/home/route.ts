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

/* -------- 60s response cache --------
 * The home screen is identical for every visitor (global catalog data), but
 * it used to re-run its whole build — including ~75 SEQUENTIAL catalog
 * upsert writes — inside the request path on every visit. Coming back from
 * the player (exit → homepage) re-mounts HomeView and refetches /api/home,
 * so that cost landed on every single return home: the hero sat on its
 * skeleton for seconds. The built payload is now memoized for 60s (a
 * rebuild happens at most once a minute, and NEVER on cache hits), and the
 * persistence loop was demoted to fire-and-forget bookkeeping — the sync
 * endpoint keeps healing the catalog in the background anyway. */
let homeCache: { at: number; payload: HomePayload } | null = null;
const HOME_CACHE_MS = 60_000;
const HOME_HTTP_CACHE = "public, s-maxage=60, stale-while-revalidate=120";

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
  // 0) cache hit — serve the built payload instantly (this is the path every
  //    return-to-home takes; the hero must snap in, not rebuild the world)
  if (homeCache && Date.now() - homeCache.at < HOME_CACHE_MS) {
    return NextResponse.json(homeCache.payload, { headers: { "Cache-Control": HOME_HTTP_CACHE } });
  }

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
  //    (persistence of what we saw happens AFTER the payload is built — and
  //    fire-and-forget, so no visitor ever waits on bookkeeping writes)
  const rows = await db.anime.findMany({ where: { inCatalog: true } });
  const catalog = rows.map(lite);
  const byId = new Map(catalog.map((a) => [a.malId, a]));

  const byPop = [...catalog].sort((a, b) => (a.popularity ?? 999999) - (b.popularity ?? 999999));
  const byScore = [...catalog].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const pickFrom = (list: JikanAnime[] | undefined, n: number): AnimeLite[] =>
    dedup((list ?? []).map((a) => byId.get(a.mal_id)).filter((a): a is AnimeLite => !!a)).slice(0, n);

  // Hero is PINNED to ONE PIECE (malId 21) — the flagship title is always the
  // first thing on the home screen, every visit, no rotation.
  const onePiece = byId.get(21);
  const hero = onePiece ? [onePiece] : [];

  // cross-row de-dupe: each rail claims titles the earlier rails didn't use,
  // so the home screen reads as SEVEN genuinely different lists (the old build
  // served ~3 unique lists with the same shows reshuffled).
  const used = new Set<number>(hero.map((h) => h.malId));
  const claim = (items: AnimeLite[], n: number): AnimeLite[] => {
    const out: AnimeLite[] = [];
    for (const a of items) {
      if (used.has(a.malId)) continue;
      used.add(a.malId);
      out.push(a);
      if (out.length >= n) break;
    }
    return out;
  };

  // Spotlight: AniList's airing board (fallback: airing in catalog by popularity)
  const airingRaw = pickFrom(airing, 24).length ? pickFrom(airing, 24) : catalog.filter((a) => a.airing).sort((a, b) => (a.popularity ?? 999999) - (b.popularity ?? 999999));
  const spotlight = claim(airingRaw, 12);

  // Trending: live AniList heat
  const trending = claim(pickFrom(popular, 24), 12);

  // Most Popular: the popularity ranking
  const mostPopular = claim(pickFrom(top, 24), 12);

  // Top Airing: soonest next-episode drops first (DB-driven — shows a "drops
  // within hours" ordering, not just a popularity clone of Spotlight)
  const byNextAir = catalog
    .filter((a) => a.airing && typeof a.nextEpisodeAt === "number")
    .sort((a, b) => (a.nextEpisodeAt ?? 0) - (b.nextEpisodeAt ?? 0));
  const topAiring = claim(byNextAir.length >= 4 ? byNextAir : airingRaw, 12);

  // Most Favorite: favorites next-tier; the FALLBACK resolves BEFORE claiming
  // so a weak favorites feed can't silently re-pick the same titles Trending
  // already showed
  const favRaw = pickFrom(favorite, 24);
  const mostFavoriteRaw = favRaw.length >= 4 ? favRaw : byScore.slice(0, 24);
  const mostFavorite = claim(mostFavoriteRaw, 12);

  // New Episodes: REAL import recency — the episodes our catalog actually
  // pulled in most recently (TV/ONA), straight from Episode rows. The old
  // build served dedup(spotlight) here, i.e. literally the Spotlight again.
  const recentEpAnime = await db.episode.findMany({
    orderBy: { addedAt: "desc" },
    take: 300,
    select: { animeId: true, addedAt: true },
  });
  const newEpisodes: AnimeLite[] = [];
  {
    const seenAnime = new Set<number>();
    for (const r of recentEpAnime) {
      const a = byId.get(r.animeId);
      if (!a || seenAnime.has(a.malId)) continue;
      if (a.type && !["TV", "ONA"].includes(a.type)) continue;
      seenAnime.add(a.malId);
      newEpisodes.push(a);
      if (newEpisodes.length >= 12) break;
    }
  }

  // Most Watched moved OUT of this payload: the home cache (60s) + the CDN
  // cache (s-maxage 60 + SWR 120) made it up to ~3 minutes stale. The client
  // now renders it live from /api/watchtime?all=1 (no-store) — REAL all-time
  // seconds from every viewer on the site + app combined, fresh on every
  // open and every 60s poll.

  const sections: HomePayload["sections"] = [
    { key: "spotlight", title: "Spotlight", items: spotlight },
    { key: "trending", title: "Trending", items: trending.length ? trending : claim(byPop, 12) },
    { key: "most-popular", title: "Most Popular", items: mostPopular.length ? mostPopular : claim(byScore, 12) },
    { key: "top-airing", title: "Top Airing", items: topAiring },
    { key: "most-favorite", title: "Most Favorite", items: mostFavorite },
    { key: "new-episodes", title: "New Episodes", items: newEpisodes.length ? newEpisodes : claim(byPop, 12) },
  ];

  // GENRE rails — "See More" discovery for the big genres (owner ask: on PC
  // there was no way to browse the rest of a genre from the home screen).
  // Each rail claims titles the earlier rails didn't use; the key prefix
  // `genre-` tells the client to attach the See More jump to /genre/{name}.
  const GENRE_RAILS = ["Action", "Adventure", "Comedy", "Fantasy", "Sci-Fi", "Romance"];
  for (const g of GENRE_RAILS) {
    const inGenre = catalog
      .filter((a) => a.genres.includes(g))
      .sort((a, b) => (a.popularity ?? 999999) - (b.popularity ?? 999999));
    const picked = claim(inGenre, 12);
    if (picked.length >= 4) sections.push({ key: `genre-${g.toLowerCase()}`, title: g, items: picked });
  }
  // Top 10 Today moved to /api/watchtime — it now ranks anime by how long
  // people ACTUALLY watch them per day, and stays empty until they do.

  const sync = await lastSync();
  const payload: HomePayload = {
    hero,
    sections,
    lastSync: { at: sync.at },
  };
  homeCache = { at: Date.now(), payload };
  // 5) persist everything we saw (non-catalog rows are kept as import
  //    suggestions) — out of band, AFTER the visitor already got their answer
  persistSeenAsync([top, popular, airing, favorite, season], popRank);
  return NextResponse.json(payload, { headers: { "Cache-Control": HOME_HTTP_CACHE } });
}

/** Fire-and-forget persistence of the ranking rows we just showed. The old
 *  code awaited these ~75 sequential upserts INSIDE the request — the single
 *  biggest reason the home screen (hero included) felt slow. Nothing here
 *  feeds the current response; the sync endpoint + the next rebuild pick it
 *  up. */
function persistSeenAsync(
  lists: JikanAnime[][],
  popRank: Map<number, number>,
): void {
  void (async () => {
    try {
      const seenIds = new Set<number>();
      const all: JikanAnime[] = [];
      for (const list of lists) {
        for (const a of list) {
          if (seenIds.has(a.mal_id)) continue;
          seenIds.add(a.mal_id);
          all.push(a);
        }
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
    } catch {
      /* bookkeeping — never surfaces to the viewer */
    }
  })();
}
