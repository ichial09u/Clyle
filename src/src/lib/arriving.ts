import { db } from "@/lib/db";
import { anilist } from "@/lib/anilist";

/**
 * "Arriving" — the Netflix-style coming-soon rail.
 *
 * Every drop the catalog (and the season ahead) has scheduled, with the SAME
 * tags Netflix uses for its "Arriving" row, mapped onto anime:
 *   NEW SERIES  — a premiere (first episode / not-yet-released show)
 *   NEW MOVIE   — a movie premiere
 *   EP n        — the next episode of something already airing
 *
 * Two data sources, merged:
 *   1. AniList's airingSchedules for the next 3 weeks (exact-to-the-second
 *      air times for BOTH premieres and weekly episodes — including shows
 *      the catalog will auto-import on premiere day).
 *   2. The catalog itself (Anime.nextEpisodeAt / "Not yet aired" rows) —
 *      resilience when AniList hiccups and coverage for shows whose exact
 *      schedule entry sits outside the fetched window.
 *
 * Snapshots live in Top10Meta (generic KV) so the rail answers instantly on
 * cold serverless starts, mirroring top10-month.ts: refresh is scheduled with
 * after() by the route (a floating promise gets frozen on Vercel), TTL-gated
 * to 30 minutes with a 60s floor for forced "?fresh=1" open-kicks.
 */

const SNAPSHOT_KEY = "arriving.snapshot";
const REFRESHED_KEY = "arriving.refreshedAt";
const REFRESH_TTL_MS = 30 * 60 * 1000;
/** Minimum gap between FORCED (open-kick) refreshes — rapid reopens stay cheap. */
const FORCE_REFRESH_FLOOR_MS = 60_000;

/** How far ahead the rail looks. */
const WINDOW_DAYS = 21;
/** Snapshot size cap — the rail renders ~20, the rest keep it stable. */
const MAX_ITEMS = 40;

export type ArrivingKind = "series" | "movie" | "episode";

export interface ArrivingItem {
  malId: number;
  title: string;
  image: string | null;
  kind: ArrivingKind;
  /** episode number for kind="episode"; null for premieres */
  episode: number | null;
  /** unix SECONDS (UTC) of the drop; null = date unknown (TBA) */
  airingAt: number | null;
  inCatalog: boolean;
}

interface Snapshot {
  day: string;
  items: ArrivingItem[];
}

/* --------------------------- AniList schedule --------------------------- */

const ARRIVING_QUERY = `
query Arriving($from: Int, $to: Int) {
  Page(page: 1, perPage: 50) {
    airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
      episode
      airingAt
      media {
        idMal
        title { romaji english }
        coverImage { extraLarge large }
        format
        status
        isAdult
      }
    }
  }
}`;

interface ScheduleNode {
  episode?: number | null;
  airingAt?: number | null;
  media?: {
    idMal?: number | null;
    title?: { romaji?: string | null; english?: string | null } | null;
    coverImage?: { extraLarge?: string | null; large?: string | null } | null;
    format?: string | null;
    status?: string | null;
    isAdult?: boolean | null;
  } | null;
}

/** Tag a schedule entry the Netflix way. */
function tagOf(format: string | null | undefined, status: string | null | undefined, episode: number | null): ArrivingKind | null {
  if (format === "MOVIE") return "movie";
  if (status === "NOT_YET_RELEASED" || (episode != null && episode <= 1)) return "series";
  if (episode != null) return "episode";
  return null;
}

/* ------------------------------- snapshot ------------------------------- */

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

/* ------------------------------ data build ------------------------------ */

interface CatalogRow {
  malId: number;
  title: string;
  titleEnglish: string | null;
  image: string | null;
  type: string | null;
  status: string | null;
  nextEpisodeAt: number | null;
  nextEpisodeNum: number | null;
}

/**
 * Rebuild the arriving list. AniList's schedule is the primary source (exact
 * times, premieres included); the catalog fills gaps and keeps the rail alive
 * when AniList is unreachable. Every new-episode entry must be in the catalog
 * (a drop of something Clyle doesn't carry is not "arriving" here); premieres
 * stay even for shows the season sweep will import on day one.
 */
async function buildArriving(): Promise<ArrivingItem[]> {
  const nowS = Math.floor(Date.now() / 1000);
  const toS = nowS + WINDOW_DAYS * 86400;

  // ---- catalog rows once (membership + supplement) ----
  const catRows: CatalogRow[] = await db.anime.findMany({
    where: { inCatalog: true, OR: [{ nextEpisodeAt: { gt: nowS } }, { status: "Not yet aired" }] },
    select: { malId: true, title: true, titleEnglish: true, image: true, type: true, status: true, nextEpisodeAt: true, nextEpisodeNum: true },
  });
  const catMap = new Map(catRows.map((r) => [r.malId, r]));

  // merged output — key: `${malId}:${kind}:${episode ?? 0}`; first writer wins
  // because writers arrive in priority order (schedule premiere > episode,
  // exact time > TBA)
  const out = new Map<string, ArrivingItem>();
  const put = (item: ArrivingItem, exact: boolean) => {
    const key = `${item.malId}:${item.kind}:${item.episode ?? 0}`;
    const prev = out.get(key);
    if (!prev || (!prev.airingAt && exact)) out.set(key, item);
  };

  // ---- source 1: AniList airingSchedules (nearest first) ----
  const data = await anilist<{ Page?: { airingSchedules?: Array<ScheduleNode | null> | null } | null }>(
    ARRIVING_QUERY,
    { from: nowS, to: toS },
    { retries: 1 },
  );

  const seenKind = new Map<number, ArrivingKind>();
  for (const node of data?.Page?.airingSchedules ?? []) {
    if (!node?.media || !node.airingAt) continue;
    const m = node.media;
    const malId = m.idMal ?? null;
    if (!malId || malId <= 0 || m.isAdult) continue;
    const ep = Number.isFinite(node.episode) ? (node.episode as number) : null;
    const kind = tagOf(m.format, m.status, ep);
    if (!kind) continue;

    const inCatalog = catMap.has(malId);
    // a "new episode" drop only counts when the catalog carries the show
    if (kind === "episode" && !inCatalog) continue;
    // premieres supersede plain episode entries for the same show
    if (kind !== "episode") {
      const prevKind = seenKind.get(malId);
      if (prevKind === "series" || prevKind === "movie") continue;
      seenKind.set(malId, kind);
    }

    const title = (m.title?.english?.trim() || m.title?.romaji?.trim() || `Anime ${malId}`).slice(0, 200);
    const image = m.coverImage?.extraLarge ?? m.coverImage?.large ?? catMap.get(malId)?.image ?? null;
    put(
      {
        malId,
        title,
        image,
        kind,
        episode: kind === "episode" ? ep : null,
        airingAt: node.airingAt,
        inCatalog,
      },
      true,
    );
  }

  // ---- source 2: catalog supplement (resilience + window gaps) ----
  for (const r of catRows) {
    if (r.status === "Not yet aired") {
      // premiere without a schedule entry yet — TBA date, sorted last
      put(
        {
          malId: r.malId,
          title: r.titleEnglish?.trim() || r.title,
          image: r.image,
          kind: r.type === "Movie" ? "movie" : "series",
          episode: null,
          airingAt: null,
          inCatalog: true,
        },
        false,
      );
    } else if (r.nextEpisodeAt && r.nextEpisodeAt > nowS && r.nextEpisodeAt <= toS) {
      put(
        {
          malId: r.malId,
          title: r.titleEnglish?.trim() || r.title,
          image: r.image,
          kind: "episode",
          episode: r.nextEpisodeNum ?? null,
          airingAt: r.nextEpisodeAt,
          inCatalog: true,
        },
        false,
      );
    }
  }

  // ---- order: by air time (TBA last), premieres before episode drops on ties ----
  const kindOrder: Record<ArrivingKind, number> = { series: 0, movie: 1, episode: 2 };
  const items = [...out.values()].sort((a, b) => {
    if (a.airingAt != null && b.airingAt != null) {
      if (a.airingAt !== b.airingAt) return a.airingAt - b.airingAt;
    } else if (a.airingAt != null) return -1;
    else if (b.airingAt != null) return 1;
    if (kindOrder[a.kind] !== kindOrder[b.kind]) return kindOrder[a.kind] - kindOrder[b.kind];
    return a.malId - b.malId;
  });

  return items.slice(0, MAX_ITEMS);
}

/* --------------------------- refresh + public --------------------------- */

let refreshing: Promise<void> | null = null;

/**
 * Re-read AniList's schedule, re-merge, save the snapshot. TTL-gated (30 min)
 * with a 60s floor for forced open-kicks, in-flight deduped — the exact
 * refresh discipline top10-month.ts uses.
 */
export async function refreshArriving(force = false): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const meta = await db.top10Meta.findUnique({ where: { key: REFRESHED_KEY } });
      const at = meta?.value ? Date.parse(meta.value) : 0;
      if (Number.isFinite(at) && Date.now() - at < (force ? FORCE_REFRESH_FLOOR_MS : REFRESH_TTL_MS)) return;
      const items = await buildArriving();
      await writeSnapshot({ day: new Date().toISOString().slice(0, 10), items });
      await db.top10Meta.upsert({
        where: { key: REFRESHED_KEY },
        create: { key: REFRESHED_KEY, value: new Date().toISOString() },
        update: { value: new Date().toISOString() },
      });
    } catch (err) {
      console.error("[arriving] refresh failed:", err instanceof Error ? err.message : err);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export interface ArrivingResult {
  items: ArrivingItem[];
  /** true when the last live pass is older than the refresh TTL (or missing) */
  stale: boolean;
  /** false only before the first successful build ever (refreshed inline) */
  hasSnapshot: boolean;
}

/**
 * The current Arriving list. Pure read + instant serve: the last known list
 * always answers; refresh scheduling belongs to the route via after().
 * Falls back to an inline forced pass when no snapshot exists (cold start).
 */
export async function getArriving(): Promise<ArrivingResult> {
  let snap = await readSnapshot();
  const meta = await db.top10Meta.findUnique({ where: { key: REFRESHED_KEY } });
  const at = meta?.value ? Date.parse(meta.value) : 0;
  const stale = !Number.isFinite(at) || Date.now() - at >= REFRESH_TTL_MS;

  if (!snap) {
    await refreshArriving(true);
    snap = await readSnapshot();
  }

  if (!snap) return { items: [], stale: true, hasSnapshot: false };

  // hydrate art/titles with the catalog's current rows (posters re-render,
  // fanart logos resolve client-side) — snapshot values stay the fallback
  try {
    const rows = snap.items.length
      ? await db.anime.findMany({
          where: { malId: { in: snap.items.map((i) => i.malId) } },
          select: { malId: true, title: true, titleEnglish: true, image: true, inCatalog: true },
        })
      : [];
    const rowMap = new Map(rows.map((r) => [r.malId, r]));
    const items = snap.items.map((i) => {
      const r = rowMap.get(i.malId);
      return r
        ? { ...i, title: r.titleEnglish?.trim() || r.title, image: r.image ?? i.image, inCatalog: r.inCatalog || i.inCatalog }
        : i;
    });
    return { items, stale, hasSnapshot: true };
  } catch {
    return { items: snap.items, stale, hasSnapshot: true };
  }
}
