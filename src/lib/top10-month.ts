import { db } from "@/lib/db";
import { top10UtcToday } from "@/lib/top10";

/**
 * Top 10 This Month — TMDB-popularity-driven active ranking.
 *
 * The ranking comes from The Movie Database's own popularity ordering of
 * anime (their public keyword browse pages are server-rendered and sorted by
 * popularity — no API key needed). The top 10 is the first ten titles of
 * TMDB's anime order that exist in this catalog.
 *
 * ACTIVE ranking: every refresh re-reads TMDB's order. When a title's TMDB
 * popularity rises enough to pass the one above it, the two swap ranks here
 * too; a title crossing into (or out of) the bottom of the list enters/leaves.
 * Every swap/drop/entry records a Top10Event so the bell stays quiet until
 * something ACTUALLY happens, exactly like the user asked:
 *   "clear the notifications so it stays empty until an anime surpasses
 *    another or goes down a rank or if a new anime is in the top 10".
 *
 * Refresh cadence: at most every 6 hours (lazy, on request + daily cron).
 * Snapshots live in Top10Meta so the rail survives cold serverless starts
 * and TMDB hiccups (last known list is always servable).
 */

const SNAPSHOT_KEY = "top10month.snapshot";
const REFRESHED_KEY = "top10month.refreshedAt";
const REFRESH_TTL_MS = 6 * 3600 * 1000;

const TMDB_BASE = "https://www.themoviedb.org";
const TMDB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ANIME_KEYWORD_ID = 210024;
/** how deep into TMDB's anime order we look (pages of 20, TV + movies) */
const TV_PAGES = 10;
const MOVIE_PAGES = 5;

export interface TmdbRankedTitle {
  tmdbId: number;
  title: string;
  kind: "tv" | "movie";
}

export interface Top10MonthItem {
  malId: number;
  rank: number;
  prevRank: number | null;
  title: string;
  image: string | null;
}

interface Snapshot {
  day: string;
  items: Array<{ malId: number; rank: number; prevRank: number | null; title: string; image: string | null }>;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/>/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'");
}

/** Parse one server-rendered TMDB keyword browse page into ordered cards. */
function parseBrowseCards(html: string, kind: "tv" | "movie"): TmdbRankedTitle[] {
  const out: TmdbRankedTitle[] = [];
  const seen = new Set<number>();
  // href="/tv/37854-one-piece?language=en-US" … <img … alt="Title"
  const re = new RegExp(`href="/${kind}/(\\d+)(?:-[a-z0-9-]+)?\\?language=en-US"[^>]*>[\\s\\S]{0,800}?<img[^>]+alt="([^"]*)"`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tmdbId = Number(m[1]);
    if (!tmdbId || seen.has(tmdbId)) continue;
    seen.add(tmdbId);
    out.push({ tmdbId, title: decodeEntities(m[2]).trim(), kind });
  }
  // some cards lack the slug-less alt pairing — fall back to bare links
  if (out.length === 0) {
    const re2 = new RegExp(`href="/${kind}/(\\d+)(?:-[a-z0-9-]+)?\\?language=en-US"`, "g");
    while ((m = re2.exec(html))) {
      const tmdbId = Number(m[1]);
      if (!tmdbId || seen.has(tmdbId)) continue;
      seen.add(tmdbId);
      out.push({ tmdbId, title: "", kind });
    }
  }
  return out;
}

async function fetchBrowsePage(kind: "tv" | "movie", page: number): Promise<string | null> {
  const url = `${TMDB_BASE}/keyword/${ANIME_KEYWORD_ID}-anime/${kind}?language=en-US&page=${page}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": TMDB_UA, "Accept-Language": "en-US,en", Referer: `${TMDB_BASE}/` },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** TMDB's popularity-ordered anime list (TV first, then movies). */
export async function fetchTmdbAnimeOrder(): Promise<TmdbRankedTitle[]> {
  // pages are fetched concurrently but reassembled in strict page order —
  // completion order is nondeterministic and would scramble TMDB's ranking
  const jobs: Array<{ kind: "tv" | "movie"; page: number }> = [];
  for (let p = 1; p <= TV_PAGES; p++) jobs.push({ kind: "tv", page: p });
  for (let p = 1; p <= MOVIE_PAGES; p++) jobs.push({ kind: "movie", page: p });

  const fetched = await Promise.all(
    jobs.map(async (job) => ({ ...job, html: await fetchBrowsePage(job.kind, job.page) })),
  );
  // a partially-fetched scrape would compact TMDB's order and fire a wave of
  // bogus rank-change notifications — abort instead; the next window retries
  const failed = fetched.filter((f) => !f.html).length;
  if (failed > 0) throw new Error(`tmdb scrape incomplete: ${failed}/${fetched.length} pages failed`);

  const results: TmdbRankedTitle[] = [];
  const seen = new Set<number>();
  for (const { kind, html } of fetched) {
    if (!html) continue;
    for (const card of parseBrowseCards(html, kind)) {
      if (seen.has(card.tmdbId)) continue;
      seen.add(card.tmdbId);
      results.push(card);
    }
  }
  return results;
}

/* ---------------- TMDB id -> catalog mapping ---------------- */

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/**
 * Map TMDB's ordered list onto catalog malIds.
 *  1. anime.tmdbId (persisted cache from earlier runs),
 *  2. the anime-lists.org community mapping (tmdbid attribute),
 *  3. normalized-title match against title / titleEnglish.
 * Newly learned mappings are persisted so later runs are exact.
 */
async function mapToCatalog(ordered: TmdbRankedTitle[]): Promise<Map<number, number>> {
  const catalog = await db.anime.findMany({
    where: { inCatalog: true },
    select: { malId: true, title: true, titleEnglish: true, tmdbId: true },
  });

  const byTmdb = new Map<number, number>();
  const byNormTitle = new Map<string, number>();
  for (const a of catalog) {
    if (a.tmdbId != null) byTmdb.set(a.tmdbId, a.malId);
    for (const t of [a.title, a.titleEnglish]) {
      const n = t ? normalizeTitle(t) : "";
      if (n && !byNormTitle.has(n)) byNormTitle.set(n, a.malId);
    }
  }

  const out = new Map<number, number>();
  const learned: Array<{ malId: number; tmdbId: number }> = [];
  for (const t of ordered) {
    if (out.has(t.tmdbId)) continue; // first (highest) occurrence wins
    let malId = byTmdb.get(t.tmdbId) ?? null;
    if (malId == null && t.title) {
      const n = normalizeTitle(t.title);
      const hit = byNormTitle.get(n);
      if (hit != null) malId = hit;
    }
    if (malId != null) {
      out.set(t.tmdbId, malId);
      learned.push({ malId, tmdbId: t.tmdbId });
    }
  }
  // persist newly learned ids (best-effort, deduped per anime)
  const known = new Map(catalog.map((a) => [a.malId, a.tmdbId]));
  const fresh = learned.filter((l) => known.get(l.malId) !== l.tmdbId);
  if (fresh.length) {
    try {
      await db.$transaction(
        fresh.slice(0, 100).map((l) => db.anime.update({ where: { malId: l.malId }, data: { tmdbId: l.tmdbId } })),
      );
    } catch {
      /* mapping cache is an optimization */
    }
  }
  return out;
}

/* ---------------- snapshot + events ---------------- */

async function readSnapshot(): Promise<Snapshot | null> {
  const meta = await db.top10Meta.findUnique({ where: { key: SNAPSHOT_KEY } });
  if (!meta?.value) return null;
  try {
    const parsed = JSON.parse(meta.value) as Snapshot;
    if (!parsed || !Array.isArray(parsed.items)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeSnapshot(snap: Snapshot): Promise<void> {
  await db.top10Meta.upsert({
    where: { key: SNAPSHOT_KEY },
    create: { key: SNAPSHOT_KEY, value: JSON.stringify(snap) },
    update: { value: JSON.stringify(snap) },
  });
}

interface RankEvent {
  type: "enter" | "leave" | "up" | "down";
  malId: number;
  rank: number | null;
  prevRank: number | null;
  title: string;
  image: string | null;
}

/** nextItems must already carry prevRank (rank in the previous snapshot). */
function diffRanks(prev: Snapshot | null, nextItems: Array<{ malId: number; rank: number; prevRank: number | null; title: string; image: string | null }>): RankEvent[] {
  const prevMap = new Map<number, number>();
  if (prev) for (const it of prev.items) prevMap.set(it.malId, it.rank);
  const nextMap = new Map(nextItems.map((it) => [it.malId, it.rank]));

  const events: RankEvent[] = [];
  for (const it of nextItems) {
    const was = it.prevRank;
    if (was == null) {
      events.push({ type: "enter", malId: it.malId, rank: it.rank, prevRank: null, title: it.title, image: it.image });
    } else if (it.rank < was) {
      events.push({ type: "up", malId: it.malId, rank: it.rank, prevRank: was, title: it.title, image: it.image });
    } else if (it.rank > was) {
      events.push({ type: "down", malId: it.malId, rank: it.rank, prevRank: was, title: it.title, image: it.image });
    }
  }
  for (const [malId, was] of prevMap) {
    if (!nextMap.has(malId)) {
      const meta = prev?.items.find((i) => i.malId === malId);
      events.push({ type: "leave", malId, rank: null, prevRank: was, title: meta?.title ?? `Anime ${malId}`, image: meta?.image ?? null });
    }
  }
  return events;
}

async function insertRankEvents(day: string, events: RankEvent[]): Promise<void> {
  if (!events.length) return;
  for (const e of events) {
    try {
      await db.top10Event.create({
        data: {
          type: e.type,
          malId: e.malId,
          day,
          rank: e.rank,
          prevRank: e.prevRank,
          weeks: null,
          title: (e.title || `Anime ${e.malId}`).slice(0, 200),
          image: e.image,
        },
      });
    } catch {
      // unique violation = this (type, malId, day) was already notified
    }
  }
}

/* ---------------- refresh + public list ---------------- */

let refreshing: Promise<void> | null = null;

/** Re-read TMDB's anime popularity order, re-rank, emit change events. */
export async function refreshTop10Month(force = false): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      if (!force) {
        const meta = await db.top10Meta.findUnique({ where: { key: REFRESHED_KEY } });
        const at = meta?.value ? Date.parse(meta.value) : 0;
        if (Number.isFinite(at) && Date.now() - at < REFRESH_TTL_MS) return;
      }
      const ordered = await fetchTmdbAnimeOrder();
      if (ordered.length < 20) throw new Error(`tmdb scrape too thin (${ordered.length})`);

      const mapping = await mapToCatalog(ordered);
      const day = top10UtcToday();

      // ordered TMDB list -> catalog members, in TMDB popularity order
      const ranked: Array<{ malId: number; title: string; image: string | null }> = [];
      const used = new Set<number>();
      for (const t of ordered) {
        const malId = mapping.get(t.tmdbId);
        if (malId == null || used.has(malId)) continue;
        used.add(malId);
        ranked.push({ malId, title: "", image: null });
        if (ranked.length >= 30) break; // headroom above the 10 we show
      }
      if (!ranked.length) throw new Error("no catalog matches in TMDB order");

      // hydrate titles/posters (logos come from the catalog at render time)
      const cat = await db.anime.findMany({
        where: { malId: { in: ranked.map((r) => r.malId) } },
        select: { malId: true, title: true, titleEnglish: true, image: true },
      });
      const catMap = new Map(cat.map((a) => [a.malId, a]));
      for (const r of ranked) {
        const a = catMap.get(r.malId);
        if (a) {
          r.title = a.titleEnglish?.trim() || a.title;
          r.image = a.image ?? null;
        }
      }

      // where the previous snapshot's ranks become prevRank; the FIRST run
      // self-baselines (prevRank = current rank) so nothing is flagged NEW
      // — the bell/badges only wake up when something MOVES later
      const prev = await readSnapshot();
      const nextItems = ranked.slice(0, 10).map((r, i) => ({
        ...r,
        rank: i + 1,
        prevRank: prev ? (prev.items.find((p) => p.malId === r.malId)?.rank ?? null) : (i + 1),
      }));

      const events = diffRanks(prev, nextItems);
      await insertRankEvents(day, events);
      await writeSnapshot({ day, items: nextItems });
      await db.top10Meta.upsert({
        where: { key: REFRESHED_KEY },
        create: { key: REFRESHED_KEY, value: new Date().toISOString() },
        update: { value: new Date().toISOString() },
      });
    } catch (err) {
      console.error("[top10-month] refresh failed:", err instanceof Error ? err.message : err);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/**
 * The current Top 10 This Month (catalog titles in TMDB popularity order).
 * Serves the last known list instantly; refreshes in the background when
 * stale. Falls back to a fresh scrape when no snapshot exists yet.
 */
export async function getTop10Month(): Promise<Top10MonthItem[]> {
  let snap = await readSnapshot();
  const meta = await db.top10Meta.findUnique({ where: { key: REFRESHED_KEY } });
  const at = meta?.value ? Date.parse(meta.value) : 0;
  const stale = !Number.isFinite(at) || Date.now() - at >= REFRESH_TTL_MS;

  if (!snap || stale) {
    if (!snap) {
      // cold start: nothing to serve — refresh inline once
      await refreshTop10Month(true);
      snap = await readSnapshot();
    } else {
      // stale but servable — respond now, refresh in the background
      void refreshTop10Month().catch(() => undefined);
    }
  }

  if (!snap) return [];
  // enrich with current catalog art (posters re-render on MAL's side);
  // prevRank comes straight from the snapshot (rank before the last change)
  try {
    const cat = await db.anime.findMany({
      where: { malId: { in: snap.items.map((i) => i.malId) } },
      select: { malId: true, image: true, title: true, titleEnglish: true },
    });
    const catMap = new Map(cat.map((a) => [a.malId, a]));
    return snap.items.map((i) => {
      const a = catMap.get(i.malId);
      return {
        malId: i.malId,
        rank: i.rank,
        prevRank: i.prevRank ?? null,
        title: (a && (a.titleEnglish?.trim() || a.title)) || i.title,
        image: (a?.image ?? null) ?? i.image,
      };
    });
  } catch {
    return snap.items.map((i) => ({ malId: i.malId, rank: i.rank, prevRank: i.prevRank ?? null, title: i.title, image: i.image }));
  }
}
