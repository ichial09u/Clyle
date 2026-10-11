import { db } from "@/lib/db";
import { jikan, posterUrl, bannerUrl, durationToMinutes, shortRating, type JikanAnime } from "@/lib/jikan";
import { anilistToJikan, freshMediaByMal, seasonNow, seasonStillAiring, airedEpisodeCount, streamingEpisodeTitlesByMal, type AniListMedia } from "@/lib/anilist";
import { tvmazeEpisodeTitles } from "@/lib/tvmaze";
import { notifySyncResult } from "@/lib/push";

/**
 * Row sources the app itself fully owns — metadata syncs must never touch
 * them (see the guard in upsertAnime). "wco" = South Park: a western
 * cartoon with no AniList/MAL existence, so any upstream payload that
 * shares its id belongs to a DIFFERENT show.
 */
const PROTECTED_SOURCES = new Set<string>(["wco"]);

/**
 * Catalog sync — keeps the Zoko catalog up to date:
 *
 *  1. Episode import: every airing anime in the catalog is checked against
 *     MAL; any episode number we do not have yet is inserted immediately,
 *     so newly-aired episodes appear in the app the moment sync runs.
 *  2. New anime import: the current season's episodic shows (TV, TV_SHORT
 *     and ONA) plus the previous season's still-airing shows are pulled
 *     from AniList and anything we do not carry yet is added to the
 *     catalog automatically.
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
  /** malIds of brand-new catalog rows this sweep added — powers "new anime" pushes */
  newAnimeIds: number[];
}

/**
 * Manual art overrides — MAL/AniList still serve decades-old posters for a few
 * long-running shows; these pin the current-era key visuals so every sync
 * keeps them instead of reverting.
 *
 * One Piece = the ELBAPH ARC art (owner request), self-hosted under /art/ so
 * it can never rot: the previous pins pointed at a third-party CDN whose URLs
 * died (twice) and blacked out the hero + every OP poster. First-party files
 * ship with the app and outlive any external host.
 */
const ART_OVERRIDES: Record<number, { image?: string; banner?: string }> = {
  21: {
    image: "/art/op-elbaph-poster.jpg", // official Elbaph arc KV (portrait)
    banner: "/art/op-elbaph-banner.jpg", // Luffy in Elbaph gear (wide)
  },
};

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
    image: ART_OVERRIDES[a.mal_id]?.image ?? posterUrl(a),
    banner: ART_OVERRIDES[a.mal_id]?.banner ?? bannerUrl(a),
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
    nextEpisodeAt: a.next_episode_airing_at ?? null,
    nextEpisodeNum: a.next_episode ?? null,
  };
}

/**
 * Adult-content gate — hentai never enters the catalog, no matter which
 * pipeline carries it (season imports, unknown-title hydration, My List
 * lookups all funnel through upsertAnime). A title is adult when MAL's own
 * markers say so: the "Hentai" genre or an "Rx - Hentai" age rating.
 * (Ecchi stays — suggestive, not explicit. AniList fetches additionally run
 * with isAdult:false at the query level, this catches the Jikan/MAL paths.)
 */
export function isAdultAnime(a: JikanAnime): boolean {
  if (a.rating && /^Rx/i.test(a.rating)) return true;
  const genres = Array.isArray(a.genres) ? a.genres : [];
  return genres.some((g) => /hentai/i.test(g?.name ?? ""));
}

/**
 * Insert or update an anime row from a Jikan-shaped payload. Returns the malId.
 *
 * AniList does not carry MAL's age-rating string, MAL rank, members count or
 * popularity RANK — those arrive as null from the mapper, so on update we
 * simply omit them instead of wiping good data that earlier MAL fetches stored.
 */
export async function upsertAnime(a: JikanAnime, opts: { inCatalog: boolean; source: string }): Promise<number> {
  if (isAdultAnime(a)) {
    // never let hentai into the catalog: if a stale row already exists keep
    // it out of browse, otherwise drop the payload entirely
    await db.anime.updateMany({ where: { malId: a.mal_id }, data: { inCatalog: false } });
    return a.mal_id;
  }
  // PROTECTED SOURCE GUARD — rows the app itself fully owns (South Park's
  // "wco" entry: a western cartoon no AniList/MAL chain knows) must never be
  // touched by metadata syncs. The /api/home sweep upserts EVERY anime the
  // AniList feed mentions; before this guard it kept re-overwriting the
  // South Park row with whatever real MAL title shared its synthetic id.
  const existing = await db.anime.findUnique({ where: { malId: a.mal_id }, select: { source: true } });
  if (existing && PROTECTED_SOURCES.has(existing.source)) return a.mal_id;
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
      // Next-episode air time: only sources that actually KNOW it (AniList's
      // nextAiringEpisode) may overwrite it. Raw MAL payloads carry no air
      // time — keep the stored value for still-airing shows (AniList filled
      // it earlier), and clear it once a show stops airing (finished/hiatus
      // schedules must not leave a stale "soon" badge behind).
      ...(row.nextEpisodeAt
        ? {}
        : a.airing
          ? { nextEpisodeAt: undefined, nextEpisodeNum: undefined }
          : { nextEpisodeAt: null, nextEpisodeNum: null }),
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
  title_english?: string | null;
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

/**
 * Anime whose MAL episode list 404s (Raijin-sha-era specials, music videos,
 * etc) — remembered per server instance so repeat visits never re-probe them.
 */
const noEpisodeList = new Set<number>();

/**
 * Acceptance filter for imported episode titles: drop empty strings and
 * MAL's "Episode 24" placeholders (a title like that would render as
 * "Episode 24: Episode 24" in the player — the plain numbered fallback
 * label is strictly better).
 */
/** Decode the HTML entities upstream titles ship with ("I&#039;m" -> "I'm").
 *  Numeric forms first, then the common named set, single pass so a literal
 *  "&amp;" in a title becomes "&" exactly once. */
export function decodeHtmlEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&(amp|quot|lt|gt|apos|nbsp|#39);/g, (_m, n) => {
      if (n === "amp") return "&";
      if (n === "quot") return '"';
      if (n === "lt") return "<";
      if (n === "gt") return ">";
      if (n === "apos" || n === "#39") return "'";
      return "\u00a0";
    });
}
function safeCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 1 || cp > 0x10ffff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

export function cleanEpisodeTitle(raw: string | null | undefined): string | null {
  const t = decodeHtmlEntities(raw ?? "").trim();
  if (!t) return null;
  // bare placeholder: "Episode 12", "Ep. 12", "Episode 12 End" — nothing else
  if (/^ep(isode)?\.?\s*\d+(\s*(end|final))?$/i.test(t)) return null;
  return t;
}

/**
 * How many Jikan pages a title backfill for this anime would need right now
 * (0 = nothing missing; -1 = known to have no MAL episode list). The episodes
 * route uses this to decide between doing the work inline (small gap, first
 * visitor gets titles immediately) vs deferring it past the response.
 */
export async function episodeTitleBackfillPages(malId: number): Promise<number> {
  if (noEpisodeList.has(malId)) return -1;
  const missing = await db.episode.findMany({
    where: { animeId: malId, lang: "sub", title: null },
    select: { number: true },
  });
  if (missing.length === 0) return 0;
  const pages = new Set<number>();
  for (const e of missing) pages.add(Math.floor((e.number - 1) / 100) + 1);
  return pages.size;
}

/**
 * Fill in missing episode titles so the player header can show the real
 * name ("Episode 1: Ryomen Sukuna") instead of "Episode 1 DUB". Two sources:
 *
 *  1. AniList streamingEpisodes — healthy, cached 24h; covers most popular
 *     shows completely and gives long-runners their recent window.
 *  2. MAL's paginated episode list (Jikan) — comprehensive, but the public
 *     origin is flaky; only the pages holding untitled episodes are fetched
 *     (100 episodes per page).
 *
 * A no-op once titles are present.
 */
export async function backfillEpisodeTitles(malId: number): Promise<number> {
  if (noEpisodeList.has(malId)) return 0;
  let missing = await db.episode.findMany({
    where: { animeId: malId, lang: "sub", title: null },
    select: { number: true },
    orderBy: { number: "asc" },
  });
  if (missing.length === 0) return 0;

  let filled = 0;

  // ---- source 1: AniList streamingEpisodes --------------------------------
  const streaming = await streamingEpisodeTitlesByMal(malId).catch(() => []);
  if (streaming.length > 0) {
    const wantStream = new Set(missing.map((e) => e.number));
    for (const e of streaming) {
      if (!wantStream.has(e.number)) continue;
      const title = cleanEpisodeTitle(e.title);
      if (!title) continue;
      const r = await db.episode.updateMany({
        where: { animeId: malId, number: e.number, lang: "sub", title: null },
        data: { title },
      });
      filled += r.count;
    }
    if (filled > 0) {
      missing = await db.episode.findMany({
        where: { animeId: malId, lang: "sub", title: null },
        select: { number: true },
        orderBy: { number: "asc" },
      });
      if (missing.length === 0) return filled; // AniList covered everything
    }
  }

  // ---- source 1.5: TVmaze (the current-season lifeline) -------------------
  // AniList's streamingEpisodes simply DO NOT EXIST for most non-Crunchyroll
  // seasonal shows (Mushoku Tensei III / Clevatess II / LIAR GAME …) and for
  // One Piece they stop at ep 130 — but MAL's episode list lags days or is
  // never filled for those same shows. TVmaze (TheTVDB) carries real names
  // for airing shows within ~a day; the join key is the broadcast date
  // derived from AniList's schedule, since TVmaze numbers episodes per
  // year-season, not absolutely.
  {
    const missingNums = missing.map((e) => e.number);
    // only the newest window matters in practice (what Latest/Continue
    // Watching show); cap the work for pathological all-untitled catalogs
    const wanted = missingNums.slice(-24);
    const anime = await db.anime.findUnique({
      where: { malId },
      select: { title: true, titleEnglish: true, year: true, nextEpisodeNum: true, nextEpisodeAt: true },
    });
    if (anime) {
      const titles = await tvmazeEpisodeTitles({
        malId,
        titleEnglish: anime.titleEnglish,
        title: anime.title,
        year: anime.year,
        wanted,
        nextEpisodeNum: anime.nextEpisodeNum,
        nextEpisodeAtSec: anime.nextEpisodeAt,
      }).catch(() => new Map<number, string>());
      for (const [ep, name] of titles) {
        const title = cleanEpisodeTitle(name);
        if (!title) continue;
        const r = await db.episode.updateMany({
          where: { animeId: malId, number: ep, lang: "sub", title: null },
          data: { title },
        });
        filled += r.count;
      }
      if (filled > 0) {
        missing = await db.episode.findMany({
          where: { animeId: malId, lang: "sub", title: null },
          select: { number: true },
          orderBy: { number: "asc" },
        });
        if (missing.length === 0) return filled;
      }
    }
  }

  // ---- source 2: MAL's paginated episode list (Jikan) ---------------------
  const wantTitle = new Set(missing.map((e) => e.number));
  const pages = [...new Set(missing.map((e) => Math.floor((e.number - 1) / 100) + 1))].sort((a, b) => a - b);

  let listedPages = 0;
  for (const page of pages) {
    const res = await jikan<{ data: JikanEpisodeEntry[] }>(`/anime/${malId}/episodes?page=${page}`).catch(
      () => null,
    );
    if (!res?.data?.length) continue;
    listedPages++;
    for (const e of res.data) {
      if (!wantTitle.has(e.mal_id)) continue;
      const title = cleanEpisodeTitle(e.title) ?? cleanEpisodeTitle(e.title_english) ?? null;
      if (!title) continue;
      const r = await db.episode.updateMany({
        where: { animeId: malId, number: e.mal_id, lang: "sub", title: null },
        data: { title },
      });
      filled += r.count;
    }
  }

  // every probed page 404'd AND AniList had nothing — MAL simply has no
  // episode list for this anime; stop probing on future visits
  if (listedPages === 0 && streaming.length === 0) noEpisodeList.add(malId);
  return filled;
}

async function runSync(_force = false): Promise<SyncResult> {
  const startedAt = new Date();
  const log = await db.syncLog.create({ data: { startedAt } });
  let episodesAdded = 0;
  let animeAdded = 0;
  let animeChecked = 0;
  let error: string | undefined;
  const newEpisodes: Array<{ malId: number; ep: number; lenMin?: number | null }> = [];
  const newAnimeIds: number[] = [];

  try {
    // ---------------------------------------------------------------
    // 1) Episode import for airing catalog anime (new episodes first!)
    // ---------------------------------------------------------------
    const airing = await db.anime.findMany({
      where: { inCatalog: true, airing: true },
      select: { malId: true, totalEpisodes: true, durationMin: true },
      // Stalest first (never-synced rows — lastSyncedAt null — sort first):
      // each check bumps lastSyncedAt, so the 12 slots round-robin over the
      // whole airing catalog. The old popularity order was poisoned by
      // pop-null season imports (SQLite sorts NULLs first) — flagship
      // titles like One Piece never got checked at all.
      orderBy: [{ lastSyncedAt: "asc" }, { popularity: "asc" }],
      take: 12, // keep the run inside Jikan's per-minute budget
    });

    // Flagship airing titles are checked on EVERY sync (round-robin alone
    // can leave them behind dozens of stale imports for days): their air
    // times drive the "New episode soon" card badges and the hero countdown,
    // which must never lag a schedule change.
    const priority = await db.anime.findMany({
      where: { inCatalog: true, airing: true, popularity: { not: null } },
      orderBy: { popularity: "asc" },
      take: 3,
      select: { malId: true, totalEpisodes: true, durationMin: true },
    });
    const prioIds = new Set(priority.map((a) => a.malId));
    const batch = [...priority, ...airing.filter((a) => !prioIds.has(a.malId))];

    for (const a of batch) {
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
      // persist the exact next-episode air time alongside the check — this
      // loop is the freshest path (runs on every app open + cron), so the
      // "New episode soon" badges and the hero countdown stay accurate
      const nextAir = media.status === "RELEASING" ? media.nextAiringEpisode ?? null : null;
      await db.anime.update({
        where: { malId: a.malId },
        data: {
          lastSyncedAt: new Date(),
          nextEpisodeAt: nextAir?.airingAt ?? null,
          nextEpisodeNum: nextAir?.episode ?? null,
        },
      });
      if (aired > a.totalEpisodes) {
        await db.anime.update({ where: { malId: a.malId }, data: { totalEpisodes: aired } });
      }
      // Drive the import off the REAL row count, not totalEpisodes: seasonal
      // rows carry AniList's planned episode count in totalEpisodes (written
      // by upserts before the season even starts), so `aired > totalEpisodes`
      // stayed false forever once the plan matched the aired count and the
      // newest episodes never imported (Apothecary S3 ep2: total=2, rows=1,
      // aired=2 — a permanent dead zone under the old gate).
      const haveRows = await db.episode.count({ where: { animeId: a.malId, lang: "sub" } });
      if (aired > haveRows) {
        const added = await importEpisodes(a.malId, aired);
        episodesAdded += added.length;
        newEpisodes.push(...added.map((ep) => ({ malId: a.malId, ep, lenMin: a.durationMin })));
      }
    }

    // ---------------------------------------------------------------
    // 2) New anime import — episodic shows of the current season we do
    //    not carry yet. TV, TV_SHORT and ONA all qualify: web-first
    //    exclusives like Overgeared (MAL 64340, the #13 most-popular
    //    show of its season) air as ONA, and the old TV-only filter
    //    silently dropped every one of them. Movies / specials / OVAs
    //    stay out — one-offs the episodic catalog can't represent.
    //
    //    The previous season's still-RELEASING shows are swept too, so
    //    a premiere that straddled the season boundary can't be missed.
    //
    //    Already-carried rows are refreshed ONLY when AniList now says
    //    RELEASING while our row still says not-airing — that is the
    //    pre-premiere import whose show has finally started; the
    //    refresh flips airing=true (so step 1 checks it from now on)
    //    and pulls the episodes that aired since. Without this the row
    //    sat in the catalog with zero episodes forever.
    // ---------------------------------------------------------------
    const season = [...(await seasonNow()), ...(await seasonStillAiring())];
    const seenIds = new Set<number>();
    for (const media of season) {
      if (seenIds.has(media.id)) continue;
      seenIds.add(media.id);
      if (media.isAdult) continue; // skip hentai
      if (media.format && media.format !== "TV" && media.format !== "TV_SHORT" && media.format !== "ONA") continue;
      const malId = media.idMal ?? null;
      if (!malId) continue; // no MAL mapping -> no Zoko player
      const known = await db.anime.findUnique({ where: { malId }, select: { inCatalog: true, airing: true } });
      if (known?.inCatalog && (known.airing || media.status !== "RELEASING")) continue;
      await upsertAniListMedia(media, { inCatalog: true, source: "season-import" });
      const added = await importEpisodes(malId, airedEpisodeCount(media) ?? 0);
      const meta = await db.anime.findUnique({ where: { malId }, select: { durationMin: true } });
      newEpisodes.push(...added.map((ep) => ({ malId, ep, lenMin: meta?.durationMin })));
      if (!known?.inCatalog) {
        animeAdded++;
        newAnimeIds.push(malId);
      }
    }

    // ---------------------------------------------------------------
    // 3) Titles for the episodes this sync just imported — the AniList
    //    aired-count path creates bare rows; MAL's list has the names
    //    ("Ryomen Sukuna"). Bounded: only pages with untitled episodes.
    // ---------------------------------------------------------------
    const importedShowIds = new Set(newEpisodes.map((n) => n.malId));
    for (const malId of importedShowIds) {
      await backfillEpisodeTitles(malId).catch(() => undefined);
    }

    // ---------------------------------------------------------------
    // 3b) HEAL previously-untitled episodes on airing shows — a same-day
    //     import usually beats MAL's episode-list publishing (One Piece:
    //     Zoko serves ep 1180 from AniList's aired count while MAL's list
    //     still ends at 1168). The import-time backfill above runs BEFORE
    //     MAL has the names, and without this retry the row stays
    //     "Episode N" until a user happens to reopen the page days later.
    //     Bounded: 4 stalest-checked airing shows per sweep — the moment
    //     MAL publishes, the next sync (arrival kick / cron) fills them.
    // ---------------------------------------------------------------
    if (episodesAdded > 0 || Math.random() < 0.25) {
      try {
        // relation EXISTS filter — the naive two-step (distinct animeIds with
        // untitled rows -> IN [...]) blew SQLite's parameter limit once the
        // untitled set grew to five figures
        const heal = await db.anime.findMany({
          where: {
            inCatalog: true,
            airing: true,
            episodes: { some: { lang: "sub", title: null } },
            malId: { notIn: [...importedShowIds] },
          },
          orderBy: { lastSyncedAt: "asc" },
          take: 4,
          select: { malId: true },
        });
        for (const a of heal) {
          await backfillEpisodeTitles(a.malId).catch(() => undefined);
        }
      } catch {
        /* heal is best-effort */
      }
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
  // lock-screen delivery for everything this sweep just made live — best
  // effort, never blocks the sync result
  void notifySyncResult({ episodesAdded, animeAdded, newEpisodes, newAnimeIds }).catch(() => undefined);
  return {
    ok: !error,
    episodesAdded,
    animeAdded,
    animeChecked,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    error,
    newEpisodes,
    newAnimeIds,
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
