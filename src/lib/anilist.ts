/**
 * AniList GraphQL client — the app's PRIMARY metadata source.
 *
 * Why AniList instead of Jikan/MyAnimeList for the browsing surfaces:
 *  - Jikan fans out to MAL, which sheds load with 504s; the home hero waited
 *    on five sequential ranking calls that could each retry for seconds.
 *  - AniList answers the ENTIRE home feed (trending / popular / airing /
 *    favorites / current season) in ONE request (typically ~300ms).
 *  - Every media carries `idMal`, so Zoko player URLs
 *    (zokoanime.video/download/mal/{malId}/...) keep working unchanged.
 *  - AniList also exposes `nextAiringEpisode`, which pinpoints the exact
 *    number of AIRED episodes for long-runners whose total is unknown.
 *
 * Mirrors lib/jikan.ts: server-only, rate-limit-aware queue, in-memory cache
 * with per-endpoint TTLs, disk cache with stale-while-revalidate, and
 * stale-while-error fallbacks.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JikanAnime } from "@/lib/jikan";

const BASE = "https://graphql.anilist.co";
const MIN_INTERVAL_MS = 1100; // AniList is rate-limited (currently ~30 req/min)
// On Vercel the bundle filesystem is read-only — cache in /tmp there.
const DISK_CACHE_DIR =
  process.env.VERCEL === "1"
    ? join(tmpdir(), "anilist-cache")
    : join(process.cwd(), "db", "anilist-cache");

type CacheEntry = { data: unknown; expires: number };
const cache = new Map<string, CacheEntry>();
const revalidating = new Set<string>();

let lastRequestAt = 0;
let chain: Promise<void> = Promise.resolve();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function schedule<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/* ------------------------------ GraphQL ------------------------------ */

const MEDIA_CORE = `
  id
  idMal
  title { romaji english }
  coverImage { extraLarge large }
  bannerImage
  description
  format
  status
  episodes
  duration
  averageScore
  popularity
  favourites
  genres
  season
  seasonYear
  isAdult
  studios(isMain: true) { nodes { name } }
  trailer { id site }
  nextAiringEpisode { episode }
`;

const HOME_QUERY = `
query HomeFeed($season: MediaSeason, $year: Int) {
  trending: Page(page: 1, perPage: 25) {
    media(type: ANIME, sort: TRENDING_DESC, isAdult: false) { ${MEDIA_CORE} }
  }
  popular: Page(page: 1, perPage: 25) {
    media(type: ANIME, sort: POPULARITY_DESC, isAdult: false) { ${MEDIA_CORE} }
  }
  airing: Page(page: 1, perPage: 25) {
    media(type: ANIME, status: RELEASING, sort: POPULARITY_DESC, isAdult: false) { ${MEDIA_CORE} }
  }
  favorite: Page(page: 1, perPage: 25) {
    media(type: ANIME, sort: FAVOURITES_DESC, isAdult: false) { ${MEDIA_CORE} }
  }
  season: Page(page: 1, perPage: 25) {
    media(type: ANIME, season: $season, seasonYear: $year, sort: POPULARITY_DESC, isAdult: false) { ${MEDIA_CORE} }
  }
}`;

const MEDIA_FULL_QUERY = `
query MediaByMal($idMal: Int) {
  Media(type: ANIME, idMal: $idMal) {
    ${MEDIA_CORE}
    relations {
      edges {
        relationType
        node { ${MEDIA_CORE} }
      }
    }
    recommendations(sort: RATING_DESC, perPage: 24) {
      nodes {
        mediaRecommendation { ${MEDIA_CORE} }
      }
    }
  }
}`;

const MEDIA_FRESH_QUERY = `
query MediaFresh($idMal: Int) {
  Media(type: ANIME, idMal: $idMal) {
    id
    idMal
    episodes
    status
    nextAiringEpisode { episode }
  }
}`;

const SEARCH_QUERY = `
query SearchAnime($q: String) {
  Page(page: 1, perPage: 24) {
    media(type: ANIME, search: $q, sort: SEARCH_MATCH, isAdult: false) { ${MEDIA_CORE} }
  }
}`;

const GENRE_QUERY = `
query GenreAnime($genre: String) {
  Page(page: 1, perPage: 24) {
    media(type: ANIME, genre: $genre, sort: POPULARITY_DESC, isAdult: false) { ${MEDIA_CORE} }
  }
}`;

const SEASON_NOW_QUERY = `
query SeasonNow($season: MediaSeason, $year: Int) {
  Page(page: 1, perPage: 25) {
    media(type: ANIME, season: $season, seasonYear: $year, sort: POPULARITY_DESC, isAdult: false) { ${MEDIA_CORE} }
  }
}`;

/* ------------------------------ transport ------------------------------ */

function cacheKey(query: string, variables: Record<string, unknown>): string {
  const name = query.match(/query\s+(\w+)/)?.[1] ?? createHash("sha1").update(query).digest("hex").slice(0, 12);
  return `${name}:${JSON.stringify(variables)}`;
}

async function gqlPost(
  query: string,
  variables: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 429) throw new Error("AniList -> 429");
  if (!res.ok) throw new Error(`AniList -> ${res.status}`);
  const json = (await res.json()) as { data?: unknown; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(`AniList GraphQL: ${json.errors[0]?.message}`);
  return json.data;
}

async function rawRequest<T>(
  query: string,
  variables: Record<string, unknown>,
  maxTries: number,
): Promise<T> {
  const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRequestAt));
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();

  let lastErr: unknown = null;
  for (let tries = 0; tries < maxTries; tries++) {
    try {
      return (await gqlPost(query, variables, 15_000)) as T;
    } catch (err) {
      lastErr = err;
      const msg = String(err);
      if (msg.includes("GraphQL:") || msg.includes("-> 404")) throw err; // permanent
      if (tries < maxTries - 1) {
        await sleep(3_000 * (tries + 1)); // 429/5xx/network — back off
        lastRequestAt = Date.now();
      }
    }
  }
  throw lastErr;
}

/* ------------------------------ TTLs ------------------------------ */

const TTL_MS: Array<[RegExp, number]> = [
  [/^HomeFeed:/, 10 * 60 * 1000],
  [/^MediaByMal:/, 6 * 60 * 60 * 1000],
  [/^MediaFresh:/, 60 * 1000],
  [/^SearchAnime:/, 10 * 60 * 1000],
  [/^GenreAnime:/, 30 * 60 * 1000],
  [/^SeasonNow:/, 30 * 60 * 1000],
  [/^StreamingEpisodes:/, 24 * 60 * 60 * 1000], // episode titles barely change
];
const DEFAULT_TTL = 30 * 60 * 1000;

function ttlFor(key: string): number {
  for (const [re, ttl] of TTL_MS) if (re.test(key)) return ttl;
  return DEFAULT_TTL;
}

function diskPath(key: string): string {
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 24);
  return join(DISK_CACHE_DIR, `${hash}.json`);
}

async function diskRead(key: string): Promise<CacheEntry | null> {
  try {
    return JSON.parse(await readFile(diskPath(key), "utf8")) as CacheEntry;
  } catch {
    return null;
  }
}

async function diskWrite(key: string, entry: CacheEntry): Promise<void> {
  try {
    await mkdir(DISK_CACHE_DIR, { recursive: true });
    await writeFile(diskPath(key), JSON.stringify(entry), "utf8");
  } catch {
    /* best-effort */
  }
}

/**
 * GET a GraphQL document with queue + cache. Returns null on "not found",
 * throws only on unexpected misuse; network failures resolve to null after
 * trying stale caches (memory, then disk).
 */
export async function anilist<T = unknown>(
  query: string,
  variables: Record<string, unknown> = {},
  opts: { fresh?: boolean; retries?: number; disk?: boolean } = {},
): Promise<T | null> {
  const key = cacheKey(query, variables);
  const hit = cache.get(key);
  if (!opts.fresh && hit && hit.expires > Date.now()) return hit.data as T;

  if (opts.disk && !opts.fresh) {
    const entry = await diskRead(key);
    if (entry) {
      if (entry.expires > Date.now()) {
        cache.set(key, entry);
        return entry.data as T;
      }
      // expired: answer from the stale copy now, quietly refresh in the background
      if (!revalidating.has(key)) {
        revalidating.add(key);
        void schedule(() => rawRequest<T>(query, variables, 2))
          .then((data) => {
            const fresh: CacheEntry = { data, expires: Date.now() + ttlFor(key) };
            cache.set(key, fresh);
            return diskWrite(key, fresh);
          })
          .catch(() => undefined)
          .finally(() => revalidating.delete(key));
      }
      cache.set(key, entry);
      return entry.data as T;
    }
  }

  const maxTries = 1 + Math.max(0, opts.retries ?? 2);
  try {
    const data = await schedule(() => rawRequest<T>(query, variables, maxTries));
    const entry: CacheEntry = { data, expires: Date.now() + ttlFor(key) };
    cache.set(key, entry);
    if (opts.disk) void diskWrite(key, entry);
    return data;
  } catch (err) {
    // stale-while-error: serve expired cache if we have it
    const stale = cache.get(key);
    if (stale) return stale.data as T;
    if (opts.disk) {
      const entry = await diskRead(key);
      if (entry) return entry.data as T;
    }
    console.error("[anilist]", err instanceof Error ? err.message : err);
    return null;
  }
}

/* ------------------------------ types ------------------------------ */

export interface AniListMedia {
  id: number;
  idMal?: number | null;
  title?: { romaji?: string | null; english?: string | null } | null;
  coverImage?: { extraLarge?: string | null; large?: string | null } | null;
  bannerImage?: string | null;
  description?: string | null;
  format?: string | null;
  status?: string | null;
  episodes?: number | null;
  duration?: number | null;
  averageScore?: number | null;
  popularity?: number | null;
  favourites?: number | null;
  genres?: string[] | null;
  season?: string | null;
  seasonYear?: number | null;
  isAdult?: boolean;
  studios?: { nodes?: Array<{ name: string }> } | null;
  trailer?: { id?: string | null; site?: string | null } | null;
  nextAiringEpisode?: { episode?: number | null } | null;
  relations?: { edges?: Array<{ relationType?: string | null; node?: AniListMedia | null }> } | null;
  recommendations?: { nodes?: Array<{ mediaRecommendation?: AniListMedia | null }> } | null;
}

export interface AniListHomeFeed {
  trending: AniListMedia[];
  popular: AniListMedia[];
  airing: AniListMedia[];
  favorite: AniListMedia[];
  season: AniListMedia[];
}

interface MediaResponse {
  Media?: AniListMedia | null;
}
interface PageResponse {
  Page?: { media?: Array<AniListMedia | null> | null } | null;
}
interface HomeResponse {
  trending?: PageResponse;
  popular?: PageResponse;
  airing?: PageResponse;
  favorite?: PageResponse;
  season?: PageResponse;
}

function currentMediaSeason(): { season: "WINTER" | "SPRING" | "SUMMER" | "FALL"; year: number } {
  const now = new Date();
  const m = now.getMonth() + 1; // 1-12
  const season = m <= 3 ? "WINTER" : m <= 6 ? "SPRING" : m <= 9 ? "SUMMER" : "FALL";
  return { season, year: now.getFullYear() };
}

function pageMedia(res: PageResponse | null | undefined): AniListMedia[] {
  return (res?.Page?.media ?? []).filter((m): m is AniListMedia => !!m);
}

/** The whole home feed in one request. */
export async function homeFeed(opts: { fresh?: boolean } = {}): Promise<AniListHomeFeed | null> {
  const { season, year } = currentMediaSeason();
  const data = await anilist<HomeResponse>(HOME_QUERY, { season, year }, { fresh: opts.fresh, disk: true, retries: 1 });
  if (!data) return null;
  return {
    trending: pageMedia(data.trending),
    popular: pageMedia(data.popular),
    airing: pageMedia(data.airing),
    favorite: pageMedia(data.favorite),
    season: pageMedia(data.season),
  };
}

/** Full media record (details + relations + recommendations) by MAL id. */
export async function mediaByMal(
  malId: number,
  opts: { fresh?: boolean } = {},
): Promise<AniListMedia | null> {
  const data = await anilist<MediaResponse>(MEDIA_FULL_QUERY, { idMal: malId }, { fresh: opts.fresh, disk: true });
  return data?.Media ?? null;
}

/** Lightweight fresh lookup — episode counts & airing state only. */
export async function freshMediaByMal(malId: number): Promise<AniListMedia | null> {
  const data = await anilist<MediaResponse>(MEDIA_FRESH_QUERY, { idMal: malId }, { fresh: true, retries: 1 });
  return data?.Media ?? null;
}

/**
 * Streaming episode titles for an anime ("Episode 1 - Ryomen Sukuna"), used
 * by the episode-title backfill. Coverage follows AniList's streaming data:
 * complete for normal-length shows, a recent window for long-runners.
 */
export async function streamingEpisodeTitlesByMal(
  malId: number,
): Promise<Array<{ number: number; title: string }>> {
  const QUERY = `
    query StreamingEpisodes($idMal: Int) {
      Media(idMal: $idMal, type: ANIME) {
        streamingEpisodes { title }
      }
    }`;
  const data = await anilist<{
    Media?: { streamingEpisodes?: Array<{ title: string } | null> | null } | null;
  }>(QUERY, { idMal: malId }, { retries: 1 });
  const out: Array<{ number: number; title: string }> = [];
  for (const raw of data?.Media?.streamingEpisodes ?? []) {
    const m = raw?.title?.trim().match(/^Episode\s+(\d+)\s*[-\u2013\u2014:]\s*(.+)$/i);
    if (!m) continue;
    const number = parseInt(m[1], 10);
    const title = m[2].trim();
    if (Number.isFinite(number) && title) out.push({ number, title });
  }
  return out;
}

/** MAL-wide style search by free-text query. */
export async function searchAnime(q: string): Promise<AniListMedia[]> {
  const data = await anilist<PageResponse>(SEARCH_QUERY, { q }, { disk: true, retries: 1 });
  return pageMedia(data);
}

/** Top anime for one MAL genre/theme name. */
export async function animeByGenre(genre: string): Promise<AniListMedia[]> {
  const data = await anilist<PageResponse>(GENRE_QUERY, { genre }, { disk: true });
  return pageMedia(data);
}

/** Current TV season (for the auto-import of newer anime). */
export async function seasonNow(): Promise<AniListMedia[]> {
  const { season, year } = currentMediaSeason();
  const data = await anilist<PageResponse>(SEASON_NOW_QUERY, { season, year }, { disk: true, retries: 1 });
  return pageMedia(data);
}

/* ------------------------------ mapping ------------------------------ */

/**
 * How many episodes have ACTUALLY aired.
 *  - finished: the planned total
 *  - releasing with a schedule: the next episode number minus one
 *  - releasing without a schedule: MAL-style total if AniList knows one
 */
export function airedEpisodeCount(m: AniListMedia | null | undefined): number | null {
  if (!m) return null;
  if (m.status === "RELEASING") {
    const next = m.nextAiringEpisode?.episode;
    if (next && next > 1) return next - 1;
  }
  if (m.status === "NOT_YET_RELEASED") return 0;
  return m.episodes ?? null;
}

const FORMAT_MAP: Record<string, string> = {
  TV: "TV",
  TV_SHORT: "TV",
  MOVIE: "Movie",
  SPECIAL: "Special",
  OVA: "OVA",
  ONA: "ONA",
  MUSIC: "Music",
};

const STATUS_MAP: Record<string, string> = {
  RELEASING: "Currently Airing",
  FINISHED: "Finished Airing",
  NOT_YET_RELEASED: "Not yet aired",
  CANCELLED: "Cancelled",
  HIATUS: "Currently Airing",
};

const SEASON_MAP: Record<string, string> = {
  WINTER: "Winter",
  SPRING: "Spring",
  SUMMER: "Summer",
  FALL: "Fall",
};

/** AniList descriptions contain light HTML — the app expects plain text. */
function stripHtml(s: string | null | undefined): string | null {
  if (!s) return null;
  const text = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&hellip;/g, "…")
    .replace(/&mdash;/g, "—")
    .replace(/&nbsp;/g, " ")
    .trim();
  return text || null;
}

/**
 * Convert an AniList media into the Jikan shape the rest of the app speaks,
 * so upsertAnime / lite() keep working unchanged. Returns null when AniList
 * has no MAL mapping (Zoko's player is keyed on MAL ids).
 *
 * Fields AniList does not provide (rating / rank / members / MAL popularity
 * rank) are left null — lib/sync.ts preserves the stored values on update.
 */
export function anilistToJikan(m: AniListMedia): JikanAnime | null {
  const malId = m.idMal ?? null;
  if (!malId || malId <= 0) return null;

  const poster = m.coverImage?.extraLarge ?? m.coverImage?.large ?? null;
  return {
    mal_id: malId,
    title: m.title?.english ?? m.title?.romaji ?? `Unknown (${malId})`,
    title_english: m.title?.english ?? null,
    images: { jpg: { image_url: m.coverImage?.large ?? undefined, large_image_url: poster ?? undefined } },
    banner_image: m.bannerImage ?? null,
    synopsis: stripHtml(m.description),
    type: m.format ? FORMAT_MAP[m.format] ?? null : null,
    rating: null,
    status: m.status ? STATUS_MAP[m.status] ?? null : null,
    airing: m.status === "RELEASING",
    season: m.season ? SEASON_MAP[m.season] ?? null : null,
    year: m.seasonYear ?? null,
    episodes: airedEpisodeCount(m),
    duration: m.duration ? `${m.duration} min per ep` : null,
    score: m.averageScore != null ? m.averageScore / 10 : null,
    rank: null,
    popularity: null,
    members: null,
    favorites: m.favourites ?? null,
    genres: (m.genres ?? []).map((name) => ({ name })),
    studios: (m.studios?.nodes ?? []).map((s) => ({ name: s.name })),
    trailer:
      m.trailer?.site === "youtube" && m.trailer.id
        ? { youtube_id: m.trailer.id }
        : undefined,
  };
}

/** AniList relation enum -> the MAL relation names the UI already filters on. */
const RELATION_MAP: Record<string, string> = {
  SEQUEL: "Sequel",
  PREQUEL: "Prequel",
  PARENT: "Parent story",
  SIDE_STORY: "Side story",
  SPIN_OFF: "Spin-off",
  ALTERNATIVE: "Alternative version",
  ADAPTATION: "Adaptation",
  SUMMARY: "Summary",
  CHARACTER: "Character",
  OTHER: "Other",
  SOURCE: "Source",
  CONTAINS: "Contains",
};

export function relationName(relationType: string | null | undefined): string {
  return (relationType && RELATION_MAP[relationType]) || "Other";
}
