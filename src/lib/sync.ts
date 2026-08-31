import { db } from "@/lib/db";
import { jikan, posterUrl, bannerUrl, durationToMinutes, shortRating, type JikanAnime } from "@/lib/jikan";
import { anilistToJikan, freshMediaByMal, seasonNow, airedEpisodeCount, type AniListMedia } from "@/lib/anilist";

/**
 * Catalog sync — keeps the Zoko catalog up to date:
 *
 *  1. Episode import: every airing anime in the catalog is checked against
 *     MAL; any episode number we do not have yet is inserted immediately,
 *     so newly-aired episodes appear in the app the moment sync runs.
 *  2. New anime import: the current TV season is pulled from MAL and any
 *     anime we do not carry yet is added to the catalog automatically.
 *
 * Sync is triggered three ways:
 *  - automatically by the client when the app opens (if stale > 30 min)
 *  - manually via the "Sync now" button on the Latest tab
 *  - by the bundled GitHub Action cron (see .github/workflows/sync.yml)
 */

export interface SyncResult {
  ok: boolean;
  episodesAdded: number;
  animeAdded: number;
  animeChecked: number;
  durationMs: number;
  skipped?: boolean;
  error?: string;
  /** the (malId, ep) pairs this sync imported — used to prefetch skip times */
  newEpisodes: Array<{ malId: number; ep: number; lenMin?: number | null }>;
}

let running: Promise<SyncResult> | null = null;

export function syncInProgress(): boolean {
  return running !== null;
}

export async function syncCatalog(force = false): Promise<SyncResult> {
  if (running) return { ...(await running), skipped: true };
  running = runSync(force).finally(() => {
    running = null;
  });
  return running;
}

function toRow(a: JikanAnime) {
  return {
    title: a.title,
    titleEnglish: a.title_english ?? null,
    image: posterUrl(a),
    banner: bannerUrl(a),
    synopsis: a.synopsis ?? null,
    type: a.type ?? null,
    rating: a.rating ?? null,
    ratingShort: shortRating(a.rating),
    status: a.status ?? null,
    airing: !!a.airing,
    season: a.season ?? null,
    year: a.year ?? null,
    durationMin: durationToMinutes(a.duration),
    score: a.score ?? null,
    rank: a.rank ?? null,
    popularity: a.popularity ?? null,
    members: a.members ?? null,
    genres: JSON.stringify([...(a.genres ?? []), ...(a.themes ?? [])].map((g) => g.name)),
    studios: JSON.stringify((a.studios ?? []).map((s) => s.name)),
    trailerYt: a.trailer?.youtube_id ?? null,
    totalEpisodes: a.episodes ?? 0,
  };
}

/**
 * Insert or update an anime row from a Jikan-shaped payload. Returns the malId.
 *
 * AniList does not carry MAL's age-rating string, MAL rank, members count or
 * popularity RANK — those arrive as null from the mapper, so on update we
 * simply omit them instead of wiping good data that earlier MAL fetches stored.
 */
export async function upsertAnime(a: JikanAnime, opts: { inCatalog: boolean; source: string }): Promise<number> {
  const row = toRow(a);
  await db.anime.upsert({
    where: { malId: a.mal_id },
    create: { malId: a.mal_id, ...row, inCatalog: opts.inCatalog, source: opts.source, lastSyncedAt: new Date() },
    update: {
      ...row,
      ...(row.rating ? {} : { rating: undefined, ratingShort: undefined }),
      ...(row.rank ? {} : { rank: undefined }),
      ...(row.members ? {} : { members: undefined }),
      ...(row.popularity ? {} : { popularity: undefined }),
      lastSyncedAt: new Date(),
      ...(opts.inCatalog ? { inCatalog: true } : {}),
    },
  });
  return a.mal_id;
}

/**
 * Insert or update from an AniList media, optionally overriding the stored
 * popularity with an explicit rank position (the app sorts by ascending
 * popularity; AniList's raw popularity is a user count, not a rank).
 */
export async function upsertAniListMedia(
  m: AniListMedia,
  opts: { inCatalog: boolean; source: string; popularityRank?: number },
): Promise<number | null> {
  const conv = anilistToJikan(m);
  if (!conv) return null;
  if (opts.popularityRank) conv.popularity = opts.popularityRank;
  return upsertAnime(conv, opts);
}

/**
 * Create any episode rows (1..count) the anime does not have yet.
 * Returns the episode numbers that were added (so their skip times can be
 * imported along with them).
 */
export async function importEpisodes(malId: number, count: number): Promise<number[]> {
  if (!count || count <= 0) return [];
  const existing = await db.episode.findMany({
    where: { animeId: malId, lang: "sub" },
    select: { number: true },
  });
  const have = new Set(existing.map((e) => e.number));
  const missing: number[] = [];
  for (let n = 1; n <= count; n++) if (!have.has(n)) missing.push(n);
  if (missing.length === 0) return [];
  await db.episode.createMany({
    data: missing.map((n) => ({ animeId: malId, number: n, lang: "sub" })),
  });
  return missing;
}

interface JikanEpisodeEntry {
  mal_id: number;
  title: string | null;
  aired: string | null;
  filler?: boolean;
  recap?: boolean;
}

/**
 * For long-running airing shows MAL hides the episode count (One Piece, etc).
 * The paginated episode list still knows — its last page holds the newest
 * episodes (with titles + air dates). First page covers episodes 1-100.
 */
export async function importEpisodesFromList(malId: number): Promise<number[]> {
  const first = await jikan<{ data: JikanEpisodeEntry[]; pagination?: { last_visible_page?: number } }>(
    `/anime/${malId}/episodes?page=1`,
  );
  if (!first?.data?.length) return [];

  const pages: JikanEpisodeEntry[][] = [first.data];
  const lastPage = first.pagination?.last_visible_page ?? 1;
  if (lastPage > 1) {
    const tail = await jikan<{ data: JikanEpisodeEntry[] }>(`/anime/${malId}/episodes?page=${lastPage}`);
    if (tail?.data?.length) pages.push(tail.data);
  }

  const existing = await db.episode.findMany({ where: { animeId: malId, lang: "sub" }, select: { number: true } });
  const have = new Set(existing.map((e) => e.number));
  const added: number[] = [];
  for (const page of pages) {
    const fresh = page.filter((e) => !have.has(e.mal_id));
    if (!fresh.length) continue;
    await db.episode.createMany({
      data: fresh.map((e) => ({
        animeId: malId,
        number: e.mal_id,
        title: e.title ?? null,
        aired: e.aired ?? null,
        filler: !!e.filler,
        recap: !!e.recap,
        lang: "sub",
      })),
    });
    for (const e of fresh) have.add(e.mal_id);
    added.push(...fresh.map((e) => e.mal_id));
  }

  // keep the stored total in sync with what we discovered
  const maxEp = Math.max(...Array.from(have));
  await db.anime.updateMany({ where: { malId, totalEpisodes: { lt: maxEp } }, data: { totalEpisodes: maxEp } });
  return added;
}

async function runSync(_force = false): Promise<SyncResult> {
  const startedAt = new Date();
  const log = await db.syncLog.create({ data: { startedAt } });
  let episodesAdded = 0;
  let animeAdded = 0;
  let animeChecked = 0;
  let error: string | undefined;
  const newEpisodes: Array<{ malId: number; ep: number; lenMin?: number | null }> = [];

  try {
    // ---------------------------------------------------------------
    // 1) Episode import for airing catalog anime (new episodes first!)
    // ---------------------------------------------------------------
    const airing = await db.anime.findMany({
      where: { inCatalog: true, airing: true },
      select: { malId: true, totalEpisodes: true, durationMin: true },
      orderBy: { popularity: "asc" },
      take: 12, // keep the run inside Jikan's per-minute budget
    });

    for (const a of airing) {
      // fresh (cache-bypassing) fetch so brand-new episodes are caught immediately
      const media = await freshMediaByMal(a.malId);
      const aired = airedEpisodeCount(media);
      if (!media || aired == null) {
        // AniList has no schedule for this show yet — probe MAL's episode list
        const added = await importEpisodesFromList(a.malId);
        episodesAdded += added.length;
        newEpisodes.push(...added.map((ep) => ({ malId: a.malId, ep, lenMin: a.durationMin })));
        continue;
      }
      animeChecked++;
      await db.anime.update({
        where: { malId: a.malId },
        data: { lastSyncedAt: new Date() },
      });
      if (aired > a.totalEpisodes) {
        await db.anime.update({ where: { malId: a.malId }, data: { totalEpisodes: aired } });
        const added = await importEpisodes(a.malId, aired);
        episodesAdded += added.length;
        newEpisodes.push(...added.map((ep) => ({ malId: a.malId, ep, lenMin: a.durationMin })));
      }
    }

    // ---------------------------------------------------------------
    // 2) New anime import — current season TV shows we do not carry yet
    // ---------------------------------------------------------------
    const season = await seasonNow();
    for (const media of season) {
      if (media.format && media.format !== "TV") continue;
      if (media.isAdult) continue; // skip hentai
      const malId = media.idMal ?? null;
      if (!malId) continue; // no MAL mapping -> no Zoko player
      const known = await db.anime.findUnique({ where: { malId }, select: { inCatalog: true } });
      if (known?.inCatalog) continue;
      await upsertAniListMedia(media, { inCatalog: true, source: "season-import" });
      const added = await importEpisodes(malId, airedEpisodeCount(media) ?? 0);
      const meta = await db.anime.findUnique({ where: { malId }, select: { durationMin: true } });
      newEpisodes.push(...added.map((ep) => ({ malId, ep, lenMin: meta?.durationMin })));
      animeAdded++;
    }

    await db.syncLog.update({
      where: { id: log.id },
      data: {
        finishedAt: new Date(),
        ok: true,
        episodesAdded,
        animeAdded,
        animeChecked,
        detail: JSON.stringify({ episodesAdded, animeAdded, animeChecked }),
      },
    });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    await db.syncLog.update({
      where: { id: log.id },
      data: { finishedAt: new Date(), ok: false, detail: error },
    }).catch(() => undefined);
  }

  const finishedAt = new Date();
  return {
    ok: !error,
    episodesAdded,
    animeAdded,
    animeChecked,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    error,
    newEpisodes,
  };
}

/** Timestamp of the last successful sync (for the UI "last updated" chip). */
export async function lastSync(): Promise<{ at: string | null; episodesAdded: number; animeAdded: number }> {
  const log = await db.syncLog.findFirst({
    where: { ok: true, finishedAt: { not: null } },
    orderBy: { startedAt: "desc" },
  });
  return {
    at: log?.finishedAt?.toISOString() ?? null,
    episodesAdded: log?.episodesAdded ?? 0,
    animeAdded: log?.animeAdded ?? 0,
  };
}
