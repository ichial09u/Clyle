import { db } from "@/lib/db";
import { top10UtcToday } from "@/lib/top10";

/**
 * Top 10 This Month — Anime Trending-driven active ranking.
 *
 * The ranking comes from Anime Trending (anitrendz.com) — the community-voted
 * "Top Anime" chart they publish for the current season (their site ships the
 * full ranked chart as JSON inside its __NEXT_DATA__ payload, so we read the
 * SAME live data their charts page renders — no third-party mirror, no AniDB).
 *
 * ACTIVE ranking: every refresh re-reads Anime Trending's chart. When a
 * title's standing rises enough to pass the one above it, the two swap ranks
 * here too; a title crossing into (or out of) the bottom of the list
 * enters/leaves. Every swap/drop/entry records a Top10Event so the bell stays
 * quiet until something ACTUALLY happens, exactly like the user asked:
 *   "clear the notifications so it stays empty until an anime surpasses
 *    another or goes down a rank or if a new anime is in the top 10".
 *
 * Refresh cadence: at most every 2 hours (lazy, on request + daily cron).
 * Snapshots live in Top10Meta so the rail survives cold serverless starts
 * and anitrendz hiccups (last known list is always servable).
 */

const SNAPSHOT_KEY = "top10month.snapshot";
const REFRESHED_KEY = "top10month.refreshedAt";
const REFRESH_TTL_MS = 2 * 3600 * 1000;
/** Minimum gap between FORCED (open-kick) refreshes — rapid reopens stay cheap. */
const FORCE_REFRESH_FLOOR_MS = 60_000;

const AT_BASE = "https://www.anitrendz.com/charts/top-anime";
const AT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface AtRankedTitle {
  /** chart position on anitrendz (1 = #1) */
  position: number;
  title: string;
  titleAlt: string | null;
  votes: number | null;
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
  source: string;
  items: Array<{ malId: number; rank: number; prevRank: number | null; title: string; image: string | null }>;
}

/* ---------------- Anime Trending chart fetch ---------------- */

interface AtChoice {
  name?: string;
  nameAlt?: string | null;
  position?: number;
  total?: number;
  unranked?: boolean;
}

interface AtChartPayload {
  /** __NEXT_DATA__ nests pageProps under props; the .json data route has it top-level */
  props?: { pageProps?: AtChartPageProps };
  pageProps?: AtChartPageProps;
}

interface AtChartPageProps {
  charts?: Array<{
    name?: string;
    slug?: string;
    season?: string;
    week?: string;
    date?: string;
    unpublished?: boolean;
    choices?: AtChoice[];
  }>;
}

/** Pull the embedded Next.js data payload out of the server-rendered page. */
function parseChartChoices(html: string): AtRankedTitle[] {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) throw new Error("anitrendz: __NEXT_DATA__ not found");
  const data = JSON.parse(m[1]) as AtChartPayload;
  const pageProps = data.props?.pageProps ?? data.pageProps;
  const chart = pageProps?.charts?.find((c) => c.slug === "top-anime") ?? pageProps?.charts?.[0];
  if (!chart || !Array.isArray(chart.choices) || !chart.choices.length) throw new Error("anitrendz: chart empty");

  const out: AtRankedTitle[] = [];
  const seen = new Set<string>();
  chart.choices.forEach((c, i) => {
    const title = (c.name ?? "").trim();
    if (!title || c.unranked) return;
    const key = title.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      position: typeof c.position === "number" && c.position > 0 ? c.position : i + 1,
      title,
      titleAlt: (c.nameAlt ?? "").trim() || null,
      votes: typeof c.total === "number" ? c.total : null,
    });
  });
  // positions can be sparse/absent — trust array order as the tiebreak
  out.sort((a, b) => a.position - b.position);
  return out;
}

/** Fetch Anime Trending's live "Top Anime" chart (1 retry, 15s cap each). */
export async function fetchAnimeTrendingChart(): Promise<AtRankedTitle[]> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(AT_BASE, {
        headers: { "User-Agent": AT_UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-US,en" },
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`anitrendz HTTP ${res.status}`);
      const html = await res.text();
      const choices = parseChartChoices(html);
      if (choices.length < 20) throw new Error(`anitrendz chart too thin (${choices.length})`);
      return choices;
    } catch (err) {
      lastErr = err;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("anitrendz fetch failed");
}

/* ---------------- Anime Trending title -> catalog mapping ---------------- */

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/**
 * Strip season/sequel markers so "…S3", "…Season 3", "…3rd Season",
 * "…Part 2" and "…II" all compare equal to the base title.
 */
function stripSeason(s: string): string {
  return s
    .replace(/[\s:—–-]*\b(?:2nd|3rd|4th|5th)\s+season\b/gi, "")
    .replace(/[\s:—–-]*\bseason\s+\d+\b/gi, "")
    .replace(/[\s:—–-]*\bpart\s+\d+\b/gi, "")
    .replace(/[\s:—–-]*\bS\d{1,2}\b/gi, "")
    .replace(/[\s:—–-]+\b(?:II|III|IV|V|VI|VII|VIII|IX|X)\b$/i, "")
    .replace(/[\s:—–-]+\d+$/i, "");
}

function titleKeys(s: string): string[] {
  const out = new Set<string>();
  const full = normalizeTitle(s);
  if (full) out.add(full);
  const base = normalizeTitle(stripSeason(s));
  if (base) out.add(base);
  return [...out];
}

/** Extract an explicit season number ("S4", "Season 4", "4th Season", "III"). */
function seasonOf(s: string): number | null {
  const sN = s.match(/\bS(\d{1,2})\b/i);
  if (sN) return Number(sN[1]);
  const wN = s.match(/\bseason\s+(\d{1,2})\b/i);
  if (wN) return Number(wN[1]);
  const ord = s.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i);
  if (ord) return Number(ord[1]);
  const roman = s.match(/\b(II|III|IV|V|VI|VII|VIII|IX|X)\b\s*$/i);
  if (roman) {
    const ROMANS: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };
    return ROMANS[roman[1].toUpperCase()] ?? null;
  }
  return null;
}

/**
 * Map Anime Trending's ordered chart onto catalog malIds:
 *  1. exact normalized title (or season-stripped base) match on
 *     title / titleEnglish,
 *  2. season-stripped base match with season-aware disambiguation — AT's
 *     "Re:ZERO -…- S4: The Recapture Arc" lands on our "Re:ZERO -…- Season
 *     4" row, not the bare S1 entry that shares the same base,
 *  3. long-prefix match on the base (AT appends arc subtitles we don't
 *     carry) — guarded by a 14-char minimum so short bases like "Bleach"
 *     can never swallow their spin-offs.
 * Chart titles Zoko doesn't carry simply don't map (the rail is
 * catalog-only by design).
 */
function mapToCatalog(ordered: AtRankedTitle[], catalog: Array<{ malId: number; title: string; titleEnglish: string | null }>): Map<number, number> {
  const byFull = new Map<string, number>();
  const byBase = new Map<string, Array<{ malId: number; season: number | null }>>();
  for (const a of catalog) {
    for (const t of [a.title, a.titleEnglish]) {
      if (!t) continue;
      for (const k of titleKeys(t)) if (!byFull.has(k)) byFull.set(k, a.malId);
      const b = normalizeTitle(stripSeason(t));
      if (b && !byBase.has(b)) byBase.set(b, []);
      const list = byBase.get(b);
      if (b && list && !list.some((c) => c.malId === a.malId)) list.push({ malId: a.malId, season: seasonOf(t) });
    }
  }

  const pickBySeason = (candidates: Array<{ malId: number; season: number | null }> | undefined, atSeason: number | null): number | null => {
    if (!candidates || !candidates.length) return null;
    if (atSeason == null) return (candidates.find((c) => c.season == null) ?? candidates[0]).malId;
    return (candidates.find((c) => c.season === atSeason) ?? candidates[0]).malId;
  };

  const out = new Map<number, number>();
  for (const t of ordered) {
    let malId: number | null = null;
    for (const src of [t.title, t.titleAlt]) {
      if (!src || malId != null) continue;
      for (const k of titleKeys(src)) {
        if (byFull.has(k)) {
          malId = byFull.get(k)!;
          break;
        }
      }
      if (malId == null) {
        const base = normalizeTitle(stripSeason(src));
        malId = pickBySeason(byBase.get(base), seasonOf(src));
        if (malId == null && base.length >= 14) {
          for (const [k, candidates] of byBase) {
            if (k.startsWith(base) || base.startsWith(k)) {
              malId = pickBySeason(candidates, seasonOf(src));
              break;
            }
          }
        }
      }
      if (malId != null) break;
    }
    if (malId != null && !out.has(t.position)) out.set(t.position, malId);
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

/**
 * Re-read Anime Trending's chart, re-rank, emit change events.
 *
 * `force` (the client's "?fresh=1" open kick) bypasses the 2h TTL but is
 * floored to one live pass per minute, so PWA foreground/refresh loops and
 * quick home round-trips never hammer anitrendz.
 */
export async function refreshTop10Month(force = false): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const meta = await db.top10Meta.findUnique({ where: { key: REFRESHED_KEY } });
      const at = meta?.value ? Date.parse(meta.value) : 0;
      if (Number.isFinite(at) && Date.now() - at < (force ? FORCE_REFRESH_FLOOR_MS : REFRESH_TTL_MS)) return;
      const chart = await fetchAnimeTrendingChart();

      const catalog = await db.anime.findMany({
        where: { inCatalog: true },
        select: { malId: true, title: true, titleEnglish: true },
      });
      const mapping = mapToCatalog(chart, catalog);
      const day = top10UtcToday();

      // ordered chart -> catalog members, in Anime Trending rank order
      const ranked: Array<{ malId: number; title: string; image: string | null }> = [];
      const used = new Set<number>();
      for (const t of chart) {
        const malId = mapping.get(t.position);
        if (malId == null || used.has(malId)) continue;
        used.add(malId);
        ranked.push({ malId, title: "", image: null });
        if (ranked.length >= 30) break; // headroom above the 10 we show
      }
      if (!ranked.length) throw new Error("no catalog matches in anitrendz chart");

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
      await writeSnapshot({
        day,
        source: "anitrendz:top-anime",
        items: nextItems,
      });
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
 * The current Top 10 This Month (catalog titles in Anime Trending's chart
 * order), plus the scheduling state the route needs to keep it live.
 */
export interface Top10MonthResult {
  items: Top10MonthItem[];
  /** true when the last live pass is older than the refresh TTL (or missing) */
  stale: boolean;
  /** false only before the first successful chart pass ever (refreshed inline) */
  hasSnapshot: boolean;
}

/**
 * The current Top 10 This Month (catalog titles in Anime Trending's chart
 * order). Pure read + instant serve: the last known list always answers, and
 * refresh scheduling belongs to the route via after() — a bare floating
 * promise here got frozen on Vercel once the response was sent, which is
 * exactly why the rail went stale between daily crons. Falls back to an
 * inline forced pass when no snapshot exists at all (cold start).
 */
export async function getTop10Month(): Promise<Top10MonthResult> {
  let snap = await readSnapshot();
  const meta = await db.top10Meta.findUnique({ where: { key: REFRESHED_KEY } });
  const at = meta?.value ? Date.parse(meta.value) : 0;
  const stale = !Number.isFinite(at) || Date.now() - at >= REFRESH_TTL_MS;

  if (!snap) {
    // cold start: nothing to serve — refresh inline once
    await refreshTop10Month(true);
    snap = await readSnapshot();
  }

  if (!snap) return { items: [], stale: true, hasSnapshot: false };

  // enrich with current catalog art (posters re-render on MAL's side);
  // prevRank comes straight from the snapshot (rank before the last change)
  try {
    const cat = await db.anime.findMany({
      where: { malId: { in: snap.items.map((i) => i.malId) } },
      select: { malId: true, image: true, title: true, titleEnglish: true },
    });
    const catMap = new Map(cat.map((a) => [a.malId, a]));
    const items = snap.items.map((i) => {
      const a = catMap.get(i.malId);
      return {
        malId: i.malId,
        rank: i.rank,
        prevRank: i.prevRank ?? null,
        title: (a && (a.titleEnglish?.trim() || a.title)) || i.title,
        image: (a?.image ?? null) ?? i.image,
      };
    });
    return { items, stale, hasSnapshot: true };
  } catch {
    return {
      items: snap.items.map((i) => ({ malId: i.malId, rank: i.rank, prevRank: i.prevRank ?? null, title: i.title, image: i.image })),
      stale,
      hasSnapshot: true,
    };
  }
}
