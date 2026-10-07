/**
 * Skip-time lookup: OP/ED intervals for every catalog anime.
 *
 * Four tiers, best data wins:
 *   1. Zoko's own per-episode `skip` payload (frame-accurate, but rare —
 *      only some titles carry it)
 *   2. The vendored AniSkip community dataset (skip-times.data.json,
 *      built from aniskip's public dump — covers 42/43 catalog titles,
 *      3,290 OP entries, highest-vote row per episode)
 *   3. Per-anime consensus: openings are the SAME video across episodes,
 *      so episodes missing from the dump reuse the median interval of
 *      the anime's other episodes
 *   4. LIVE AniSkip query — for brand-new episodes (and freshly imported
 *      anime) that predate the vendored dump. Fetched once on first open,
 *      cached on disk (positive entries forever, misses 7 days) and warmed
 *      proactively by the catalog sync, so a newly imported episode
 *      effectively "imports" its own skip intro with it. The player still
 *      has its own last-resort 8-90s heuristic window for TV-length
 *      episodes with no data at all.
 *   4.5 SkipDB fills (skipdb.tv) — AniSkip doesn't cover everything (HxH
 *      2011, Code Geass R2, Oshi no Ko, Naruto Shippuden…). SkipDB is the
 *      open crowdsourced skip-timestamps database (ODbL 1.0), keyed by IMDb
 *      ids + real season/episode numbers. The backfill bot maps MAL->IMDb
 *      (Wikidata P4086+P345, Jikan backup), vendors the dump into the
 *      SkipDbFill table and refreshes weekly; this tier reads it for any
 *      episode the tiers above left blank.
 *
 * Server-side only (the dataset ships inside the server bundle).
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { db } from "@/lib/db";
import skipDataset from "./skip-times.data.json";

export interface SkipInterval {
  start: number;
  end: number;
}

export interface SkipData {
  intro?: SkipInterval;
  outro?: SkipInterval;
  /** where the data came from — handy for debugging */
  source?: "zoko" | "scout" | "aniskip" | "aniskip-live" | "skipdb" | "crowd";
}

type EpisodeEntry = { op?: [number, number]; ed?: [number, number] };
type Dataset = Record<string, Record<string, EpisodeEntry>>;

const data = skipDataset as unknown as Dataset;

/* ------------------------------------------------------------------ *
 * Tier 0 — owner-verified "no opening on this episode". Community
 * sources can carry WRONG premiere rows and have no way to express
 * absence (Tokyo Ghoul ep 1 ships a vote-backed op row in the AniSkip
 * dump, yet the broadcast runs the cold open straight into the episode
 * — the owner watched it: no OP, no button). An entry here outranks
 * EVERY tier for that episode's intro: dataset exact rows, consensus,
 * scout medians, SkipDB, live AniSkip, crowd learns. Outros are
 * untouched (premieres still have their ED).
 * ---------------------------------------------------------------- */
const OWNER_NO_INTRO: Record<number, readonly number[]> = {
  22319: [1], // Tokyo Ghoul S1 ep1 "Tragedy" — premiere has no opening
};

function ownerSaysNoIntro(malId: number, ep: number): boolean {
  return OWNER_NO_INTRO[malId]?.includes(ep) ?? false;
}

/** median across an anime's known episodes, per type */
const consensusCache = new Map<string, { op?: [number, number]; ed?: [number, number] }>();

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function consensus(malId: number): { op?: [number, number]; ed?: [number, number] } {
  const key = String(malId);
  const hit = consensusCache.get(key);
  if (hit) return hit;

  const out: { op?: [number, number]; ed?: [number, number] } = {};
  const byEp = data[key];
  if (byEp) {
    for (const type of ["op", "ed"] as const) {
      const starts: number[] = [];
      const ends: number[] = [];
      for (const entry of Object.values(byEp)) {
        const iv = entry[type];
        if (iv) {
          starts.push(iv[0]);
          ends.push(iv[1]);
        }
      }
      const s = median(starts);
      const e = median(ends);
      if (s != null && e != null) out[type] = [s, e];
    }
  }
  consensusCache.set(key, out);
  return out;
}

/** Look up OP/ED intervals for one episode: exact entry, else per-anime consensus. */
export function lookupSkipTimes(malId: number, ep: number): { intro?: SkipInterval; outro?: SkipInterval } {
  const byEp = data[String(malId)];
  const entry = byEp?.[String(ep)] ?? consensus(malId);
  if (!entry) return {};
  const out: { intro?: SkipInterval; outro?: SkipInterval } = {};
  if (entry.op) out.intro = { start: entry.op[0], end: entry.op[1] };
  if (entry.ed) out.outro = { start: entry.ed[0], end: entry.ed[1] };
  return out;
}

/**
 * The vendored dataset's EXACT op row for this episode — no consensus
 * fallback. Used to defend known openings against the scout tier's
 * "couldn't measure" verdicts: a fleet nodetect row means the bots failed
 * to cross-match THIS scan (audio quirks, odd encodes), not that the show
 * has no opening. When the community has a vote-backed op for the exact
 * episode (Kimetsu ep1: 41.3–131.3 at 10k votes), it must never be
 * silenced by a failed measurement. Consensus has no such protection —
 * finale episodes genuinely drop their OP, and the anime-wide median
 * would wrongly button them.
 */
export function exactDatasetIntro(malId: number, ep: number): SkipInterval | null {
  const entry = data[String(malId)]?.[String(ep)];
  if (!entry?.op) return null;
  return { start: entry.op[0], end: entry.op[1] };
}

function valid(iv: unknown): iv is SkipInterval {
  if (!iv || typeof iv !== "object") return false;
  const v = iv as SkipInterval;
  return Number.isFinite(v.start) && Number.isFinite(v.end) && v.end > v.start;
}

/**
 * Plausibility gate — a "skip intro" that STARTS 10 minutes into a
 * 24-minute episode is not an opening (Zoko mis-tags recap blocks and
 * random chapters as intro/outro on plenty of shows — Grand Blue ep9
 * "intro 619-709"). Since the blind 8-90s guess was removed, a WRONG
 * interval shows a wrong button — worse than no button. Anything that
 * fails the sanity shape is dropped: the Skip Intro button must actually
 * skip the opening, or not exist.
 */
export function plausibleIntro(iv: SkipInterval | undefined | null, lenMin?: number | null): iv is SkipInterval {
  if (!iv || !valid(iv)) return false;
  const cap = lenMin && lenMin > 30 ? 420 : 320; // hour-long formats may open late
  return iv.start <= cap && iv.end - iv.start <= 180;
}

export function plausibleOutro(iv: SkipInterval | undefined | null): iv is SkipInterval {
  return !!iv && valid(iv) && iv.end - iv.start <= 300;
}

/**
 * Merge Zoko's native skip payload with the AniSkip dataset.
 * Zoko wins per-field (it is frame-accurate for its own encodes);
 * the dataset fills whatever Zoko left blank. BOTH sources pass the
 * plausibility gate here — this is where early-returning callers
 * (withSkipDataLive's "nothing left to ask") would otherwise leak a
 * mis-tagged interval (Grand Blue ep9 "intro 619-709") into the player.
 */
export function withSkipData<T extends { skip?: SkipData }>(
  malId: number,
  ep: number,
  stream: T,
  opts: { episodeLengthMin?: number | null } = {},
): T & { skip?: SkipData } {
  const zoko = stream.skip ?? {};
  const filled = lookupSkipTimes(malId, ep);

  const merged: SkipData = {};
  const zi = valid(zoko.intro) && plausibleIntro(zoko.intro, opts.episodeLengthMin) ? zoko.intro : undefined;
  const zo = valid(zoko.outro) && plausibleOutro(zoko.outro) ? zoko.outro : undefined;
  const fi = valid(filled.intro) && plausibleIntro(filled.intro, opts.episodeLengthMin) ? filled.intro : undefined;
  const fo = valid(filled.outro) && plausibleOutro(filled.outro) ? filled.outro : undefined;
  // Tier 0 (owner) strips a wrong intro before it can ride any merge —
  // the dataset/zoko payloads cannot express "no opening exists"
  const intro = ownerSaysNoIntro(malId, ep) ? undefined : zi ?? fi;
  const outro = zo ?? fo;
  if (intro) merged.intro = intro;
  if (outro) merged.outro = outro;
  if (intro || outro) {
    merged.source = zi || zo ? "zoko" : "aniskip";
  }

  return { ...stream, skip: Object.keys(merged).length ? merged : undefined };
}

/* ------------------------------------------------------------------ *
 * Tier 2.5 — the intro-scout fleet. Bots watch the first minutes of
 * every catalog episode (the SAME streams the player serves) and
 * cross-match loudness envelopes across episodes: the opening is the
 * one part of a show that repeats identically, so where episodes align
 * IS the opening. Because these intervals are measured on OUR encodes,
 * they beat AniSkip's community timings (taken on other encodes, often
 * offset by recaps/stream bumps — the "skip intro is inaccurate" bug).
 * Priority: Zoko native (frame-accurate) > scout > AniSkip > crowd.
 * ---------------------------------------------------------------- */

const SCOUT_CACHE_TTL_MS = 60_000;
const scoutCache = new Map<number, { rows: Array<{ ep: number; start: number; end: number; nodetect: boolean }>; at: number }>();

async function scoutRows(malId: number): Promise<Array<{ ep: number; start: number; end: number; nodetect: boolean }>> {
  const hit = scoutCache.get(malId);
  if (hit && Date.now() - hit.at < SCOUT_CACHE_TTL_MS) return hit.rows;
  const rows = await db.introScout.findMany({
    where: { malId },
    orderBy: { updatedAt: "desc" },
    take: 60, // room for nodetect rows too — real measurements are filtered below
    select: { ep: true, start: true, end: true, nodetect: true },
  });
  scoutCache.set(malId, { rows, at: Date.now() });
  return rows;
}

/**
 * The fleet's verdict for one episode:
 *   interval set    — the opening interval (exact per-episode row, or the
 *                     anime-wide median when 2+ episodes agree)
 *   confirmedNone   — bots WATCHED this exact episode and found NO opening:
 *                     the Skip Intro button must not appear for it (no
 *                     guessing, no AniSkip resurrection)
 *   null            — the fleet has nothing on this anime
 */
export async function scoutIntro(
  malId: number,
  ep: number,
): Promise<{ interval: SkipInterval | null; exact: boolean; confirmedNone?: boolean } | null> {
  try {
    const rows = await scoutRows(malId);
    const exact = rows.find((r) => r.ep === ep);
    if (exact) {
      if (exact.nodetect) return { interval: null, exact: true, confirmedNone: true };
      // degenerate row guard — merge upserts can land as {0,0} (old establish
      // failures came back from prod without their nodetect flag); a zero or
      // inverted interval is a broken row, not a measurement. Ignore it and
      // fall through to the anime-wide median / other tiers.
      if (exact.end > exact.start) return { interval: { start: exact.start, end: exact.end }, exact: true };
    }
    // degenerate {0,0} rows are excluded here too — they must not skew the median
    const measured = rows.filter((r) => !r.nodetect && r.end > r.start);
    if (measured.length >= 2) {
      const med = (xs: number[]) => {
        const s = [...xs].sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)];
      };
      const start = med(measured.map((r) => r.start));
      const end = med(measured.map((r) => r.end));
      if (end > start && end - start <= 150 && start <= 320) {
        // PREMIERE GUARD — episode 1 is the classic no-opening episode
        // (extended cold open, or none at all), so the anime-wide median
        // may only button it when the fleet's measurements describe one
        // FIXED video: lengths must agree tightly (recap bumps move the
        // start, never the duration). Tokyo Ghoul S1's fleet "openings"
        // span 84-124 s across episodes — the cross-match latched onto
        // recurring non-OP content, and that noise's median must not
        // fabricate a button on the premiere.
        if (ep === 1) {
          const lens = measured.map((r) => r.end - r.start);
          if (Math.max(...lens) - Math.min(...lens) > 15) return null;
        }
        return { interval: { start, end }, exact: false };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Tier 3.5 — SkipDB fills (skipdb.tv, open data under ODbL 1.0).
 * For anime AniSkip doesn't have: the backfill bot maps MAL->IMDb once
 * (Wikidata + Jikan backup), vendors SkipDB's approved intro/outro segments
 * per (season, episode) into the SkipDbFill table, and re-downloads the
 * dump weekly so new episodes keep arriving. Same precedence class as the
 * vendored AniSkip dataset — community timings on other encodes — so it
 * only fills gaps the higher tiers left blank, never overrides them.
 * ---------------------------------------------------------------- */

const SKIPDB_TTL_MS = 60_000;
const skipDbCache = new Map<
  number,
  { rows: Array<{ ep: number; kind: string; start: number; end: number; confidence: number }>; at: number }
>();

async function skipDbRows(
  malId: number,
): Promise<Array<{ ep: number; kind: string; start: number; end: number; confidence: number }>> {
  const hit = skipDbCache.get(malId);
  if (hit && Date.now() - hit.at < SKIPDB_TTL_MS) return hit.rows;
  const rows = await db.skipDbFill.findMany({
    where: { malId },
    select: { ep: true, kind: true, start: true, end: true, confidence: true },
  });
  skipDbCache.set(malId, { rows, at: Date.now() });
  return rows;
}

/**
 * SkipDB's exact per-episode intervals for one episode (op/ed in seconds),
 * already sanity-gated. null when the table has nothing for this anime.
 */
export async function skipDbIntervals(
  malId: number,
  ep: number,
): Promise<{ op?: SkipInterval; ed?: SkipInterval } | null> {
  try {
    const rows = await skipDbRows(malId);
    if (!rows.length) return null;
    const out: { op?: SkipInterval; ed?: SkipInterval } = {};
    for (const kind of ["op", "ed"] as const) {
      const r = rows.find((x) => x.ep === ep && x.kind === kind);
      if (!r) continue;
      const iv = { start: r.start, end: r.end };
      if (kind === "op" && plausibleIntro(iv)) out.op = iv;
      if (kind === "ed" && plausibleOutro(iv)) out.ed = iv;
    }
    return out.op || out.ed ? out : null;
  } catch {
    return null; // table missing / db hiccup — SkipDB is optional, never fatal
  }
}

/* ------------------------------------------------------------------ *
 * Tier 4 — LIVE AniSkip lookups (cached), for episodes the vendored
 * dump + consensus don't cover: brand-new episodes of airing shows and
 * freshly imported anime. Also used to prefetch skip data when the
 * catalog sync imports new episodes (see prefetchSkipTimes below).
 * ------------------------------------------------------------------ */

const ANISKIP_API = "https://api.aniskip.com/v2/skip-times";
// Submissions trickle in over the days after an episode airs (2026-season
// shows were 404 on air day, populated within the week) — re-ask daily so a
// fresh episode picks up community times as soon as anyone submits them.
const ANISKIP_MISS_TTL_MS = 24 * 60 * 60 * 1000;
const ANISKIP_DISK_DIR =
  process.env.VERCEL === "1" ? join(tmpdir(), "aniskip-cache") : join(process.cwd(), "db", "aniskip-cache");

type LiveEntry = { op?: [number, number]; ed?: [number, number]; at: number; miss?: boolean };
type LiveTimes = { op?: [number, number]; ed?: [number, number] };
type LiveFetchResult = { times: LiveTimes | null; transient: boolean };
type LiveFile = Record<string, LiveEntry>;
const liveMem = new Map<string, LiveFile>();
const liveInFlight = new Map<string, Promise<LiveFetchResult>>();

function liveDiskPath(malId: number): string {
  const hash = createHash("sha1").update(String(malId)).digest("hex").slice(0, 16);
  return join(ANISKIP_DISK_DIR, `${hash}.json`);
}

async function liveRead(malId: number): Promise<LiveFile> {
  const key = String(malId);
  const mem = liveMem.get(key);
  if (mem) return mem;
  try {
    const file = JSON.parse(await readFile(liveDiskPath(malId), "utf8")) as LiveFile;
    liveMem.set(key, file);
    return file;
  } catch {
    return {};
  }
}

async function liveWrite(malId: number, file: LiveFile): Promise<void> {
  liveMem.set(String(malId), file);
  try {
    await mkdir(ANISKIP_DISK_DIR, { recursive: true });
    await writeFile(liveDiskPath(malId), JSON.stringify(file), "utf8");
  } catch {
    /* read-only FS (serverless) — the in-memory copy still helps this instance */
  }
}

/**
 * Ask api.aniskip.com for one episode's OP/ED times. `lenMin` is the
 * episode's length in MINUTES — the API requires an `episodeLength` param
 * (400s without it); 24 is the TV standard when we don't know better.
 * Returns the times plus whether the failure was TRANSIENT (5xx / rate
 * limit / timeout) — transient failures must NOT be negative-cached.
 */
async function fetchAniSkipLive(malId: number, ep: number, lenMin?: number): Promise<LiveFetchResult> {
  const len = lenMin && Number.isFinite(lenMin) && lenMin > 0 ? Math.round(lenMin) : 24;
  try {
    const res = await fetch(`${ANISKIP_API}/${malId}/${ep}?types=op&types=ed&episodeLength=${len}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(4_500),
    });
    if (res.status === 404) return { times: null, transient: false }; // genuine "not submitted yet"
    if (!res.ok) return { times: null, transient: true }; // 429/5xx — retry another time
    const body = (await res.json()) as {
      found?: boolean;
      results?: Array<{ interval?: { startTime?: number; endTime?: number }; skipType?: string }>;
    };
    if (!body?.found || !Array.isArray(body.results)) return { times: null, transient: false };
    const out: LiveTimes = {};
    for (const r of body.results) {
      const s = r?.interval?.startTime;
      const e = r?.interval?.endTime;
      if (!Number.isFinite(s) || !Number.isFinite(e) || e! <= s!) continue;
      if (r.skipType === "op") out.op = [s!, e!];
      else if (r.skipType === "ed") out.ed = [s!, e!];
    }
    return { times: out.op || out.ed ? out : null, transient: false };
  } catch {
    return { times: null, transient: true }; // timeout / offline — retryable
  }
}

/**
 * Cached live lookup for one episode. Positive entries are kept forever
 * (community timings don't rot); misses are retried after 7 days.
 */
async function liveLookup(malId: number, ep: number, lenMin?: number): Promise<LiveTimes | null> {
  const epKey = String(ep);
  const file = await liveRead(malId);
  const hit = file[epKey];
  if (hit && Date.now() - hit.at < (hit.miss ? ANISKIP_MISS_TTL_MS : Number.MAX_SAFE_INTEGER)) {
    return hit.miss ? null : { op: hit.op, ed: hit.ed };
  }
  const inflightKey = `${malId}/${ep}`;
  let p: Promise<LiveFetchResult> | undefined = liveInFlight.get(inflightKey);
  if (!p) {
    p = fetchAniSkipLive(malId, ep, lenMin)
      .then((r) => {
        liveInFlight.delete(inflightKey);
        return r;
      })
      .catch(() => {
        liveInFlight.delete(inflightKey);
        return { times: null, transient: true } as LiveFetchResult;
      });
    liveInFlight.set(inflightKey, p);
  }
  const wrapped = await p;
  const data = wrapped.times;
  const transient = wrapped.transient;
  if (!transient) {
    const fresh = await liveRead(malId); // another request may have written meanwhile
    fresh[epKey] = data ? { ...data, at: Date.now() } : { at: Date.now(), miss: true };
    await liveWrite(malId, fresh);
  }
  return data;
}

/**
 * Merge like `withSkipData`, plus the live AniSkip tier: anything the
 * vendored data left blank gets one (cached) live query. This is what makes
 * EVERY episode — including ones imported after the dump was built — carry
 * its skip intro/ending.
 */
export async function withSkipDataLive<T extends { skip?: SkipData }>(
  malId: number,
  ep: number,
  stream: T,
  opts: { episodeLengthMin?: number | null } = {},
): Promise<T & { skip?: SkipData }> {
  const merged = withSkipData(malId, ep, stream, opts);
  let skip: SkipData = { ...(merged.skip ?? {}) };

  // scout tier — measured on OUR encodes by the fleet. An exact per-episode
  // measurement outranks everything (including Zoko's payload, which marks
  // the repeated cold-open as "intro start" on many shows); the anime-wide
  // median only fills gaps (Zoko/frame data wins there).
  // A CONFIRMED-NONE verdict (the fleet watched this episode against an
  // established reference and found no opening) wins too — EXCEPT when this
  // exact episode already has concrete intro data: Zoko's native payload or
  // the dataset's exact op row. A nodetect is "our scan couldn't align",
  // which must never silence a vote-backed community interval for the same
  // episode (Kimetsu ep1: 10k votes vs one failed audio match). Consensus /
  // live / crowd intros are NOT protected — finale episodes genuinely drop
  // their OP and the anime-wide median must not button them.
  // The OWNER verdict (Tier 0) suppresses UNCONDITIONALLY — a human watched
  // the episode and confirmed no opening exists; no community row, however
  // vote-backed, may resurrect the button (Tokyo Ghoul ep1).
  // scout + skipdb in parallel — the two sources are independent, and the
  // sequential round-trips used to add dead latency to EVERY stream resolve
  const [scout, sdbExact] = await Promise.all([
    scoutIntro(malId, ep),
    skipDbIntervals(malId, ep),
  ]);
  const confirmedNone = !!scout?.confirmedNone;
  const ownerNone = ownerSaysNoIntro(malId, ep);
  const exactKnown = valid(stream.skip?.intro) || !!exactDatasetIntro(malId, ep) || !!sdbExact?.op;
  const suppressIntro = ownerNone || (confirmedNone && !exactKnown);
  if (suppressIntro) {
    delete skip.intro;
    if (!skip.outro) delete skip.source;
  } else if (scout?.interval && (scout.exact || !valid(stream.skip?.intro))) {
    skip.intro = scout.interval;
    skip.source = "scout";
  }
  // SkipDB fill tier — exact per-episode community rows for anime AniSkip
  // doesn't carry. Exact rows survive a fleet confirmed-none (same defense
  // as the dataset's exact op row above); they never override zoko/scout/
  // AniSkip data, only fill what's missing.
  if (!suppressIntro && (!skip.intro || !skip.outro) && sdbExact) {
    if (!skip.intro && sdbExact.op) {
      skip.intro = sdbExact.op;
      skip.source = "skipdb";
    }
    if (!skip.outro && sdbExact.ed) {
      skip.outro = sdbExact.ed;
      if (!skip.source) skip.source = "skipdb";
    }
  }
  if (skip.intro && skip.outro) return { ...merged, skip }; // nothing left to ask

  try {
    const live = await liveLookup(malId, ep, opts.episodeLengthMin ?? undefined);
    if (live) {
      if (!skip.intro && live.op && !suppressIntro) {
        skip.intro = { start: live.op[0], end: live.op[1] };
        skip.source = "aniskip-live";
      }
      if (!skip.outro && live.ed) skip.outro = { start: live.ed[0], end: live.ed[1] };
      if (skip.intro || skip.outro) {
        if (!skip.source) skip.source = "aniskip-live";
        return { ...merged, skip };
      }
    }
  } catch {
    /* live tier is best-effort — the crowd/heuristic tiers still cover episodes */
  }
  // crowd tier — for shows nobody has submitted anywhere yet, viewers who
  // scrubbed past the opening have already taught us where it ends
  // (never applied when the fleet confirmed there IS no opening)
  if (!suppressIntro) {
    try {
      const crowd = await crowdIntroTarget(malId, ep);
      if (crowd != null) {
        if (!skip.intro) {
          skip.intro = { start: 8, end: crowd };
          skip.source = "crowd";
        }
        if (skip.intro || skip.outro) return { ...merged, skip };
      }
    } catch {
      /* votes are best-effort too */
    }
  }
  // final plausibility gate — the button must actually skip the opening:
  // drop any interval that fails the sanity shape (wrong data < no button)
  if (skip.intro && !plausibleIntro(skip.intro, opts.episodeLengthMin)) {
    delete skip.intro;
    if (!skip.outro) delete skip.source;
  }
  if (skip.outro && !plausibleOutro(skip.outro)) {
    delete skip.outro;
    if (!skip.intro) delete skip.source;
  }
  return { ...merged, skip };
}

/**
 * Coverage check used by the skip audit (bot): where would this episode's
 * Skip Intro data come from? Checks the vendored dataset (exact row, then
 * per-anime consensus), then the live tier's cache — `allowLiveFetch` also
 * permits one cached network query to AniSkip (used when probing gaps), and
 * finally the crowd-learned scrub median — the audit counts anything the
 * player would actually show. `confirmedNone` = a verified NO opening on
 * this episode — the fleet's cross-match verdict, or the owner's watch-and-
 * confirm override (Tier 0). The button is suppressed by design — not a
 * coverage gap.
 */
export interface SkipCoverage {
  intro?: SkipInterval;
  outro?: SkipInterval;
  source: "scout" | "exact" | "consensus" | "skipdb" | "live" | "crowd" | "owner";
  confirmedNone?: boolean;
}

export async function skipCoverage(
  malId: number,
  ep: number,
  opts: { allowLiveFetch?: boolean; episodeLengthMin?: number | null } = {},
): Promise<SkipCoverage | null> {
  // Tier 0 first — the owner's watch-and-confirm verdict outranks every
  // data tier (reported as an intentional suppression, not a gap)
  if (ownerSaysNoIntro(malId, ep)) return { source: "owner", confirmedNone: true };
  // scout tier next — what the player would actually use (see the priority
  // in withSkipDataLive). A confirmed-none yields to an exact dataset op row
  // for THIS episode (same precedence as the player merge).
  const scout = await scoutIntro(malId, ep);
  if (scout?.confirmedNone) {
    const ex = exactDatasetIntro(malId, ep);
    if (ex && plausibleIntro(ex, opts.episodeLengthMin)) return { source: "exact", intro: ex };
    // a SkipDB exact row for this episode is also vote-backed concrete data
    // and must not be silenced by the fleet's failed cross-match
    const sdbN = await skipDbIntervals(malId, ep);
    if (sdbN?.op && plausibleIntro(sdbN.op, opts.episodeLengthMin)) return { source: "skipdb", intro: sdbN.op };
    return { source: "scout", confirmedNone: true };
  }
  if (scout?.interval) return { source: "scout", intro: scout.interval };
  const byEp = data[String(malId)];
  const exact = byEp?.[String(ep)];
  const exOp = exact?.op ? { start: exact.op[0], end: exact.op[1] } : null;
  const exEd = exact?.ed ? { start: exact.ed[0], end: exact.ed[1] } : null;
  if (exOp || exEd) {
    const cov: SkipCoverage = { source: "exact" };
    if (plausibleIntro(exOp, opts.episodeLengthMin)) cov.intro = exOp;
    if (plausibleOutro(exEd)) cov.outro = exEd;
    if (cov.intro || cov.outro) return cov;
  }
  const cons = consensus(malId);
  const coOp = cons.op ? { start: cons.op[0], end: cons.op[1] } : null;
  const coEd = cons.ed ? { start: cons.ed[0], end: cons.ed[1] } : null;
  if (coOp || coEd) {
    const cov: SkipCoverage = { source: "consensus" };
    if (plausibleIntro(coOp, opts.episodeLengthMin)) cov.intro = coOp;
    if (plausibleOutro(coEd)) cov.outro = coEd;
    if (cov.intro || cov.outro) return cov;
  }
  // SkipDB tier — the vendored-fill table for anime AniSkip doesn't have
  const sdb = await skipDbIntervals(malId, ep);
  if (sdb) {
    const cov: SkipCoverage = { source: "skipdb" };
    if (plausibleIntro(sdb.op, opts.episodeLengthMin)) cov.intro = sdb.op;
    if (plausibleOutro(sdb.ed)) cov.outro = sdb.ed;
    if (cov.intro || cov.outro) return cov;
  }
  const liveCov = (op?: [number, number], ed?: [number, number]): SkipCoverage | null => {
    const i = op ? { start: op[0], end: op[1] } : null;
    const o = ed ? { start: ed[0], end: ed[1] } : null;
    if (!plausibleIntro(i, opts.episodeLengthMin) && !plausibleOutro(o)) return null;
    const cov: SkipCoverage = { source: "live" };
    if (plausibleIntro(i, opts.episodeLengthMin)) cov.intro = i;
    if (plausibleOutro(o)) cov.outro = o;
    return cov;
  };
  if (opts.allowLiveFetch) {
    const live = await liveLookup(malId, ep, opts.episodeLengthMin ?? undefined);
    const cov = live ? liveCov(live.op, live.ed) : null;
    if (cov) return cov;
  } else {
    const cached = (await liveRead(malId))[String(ep)];
    const cov = cached && !cached.miss ? liveCov(cached.op, cached.ed) : null;
    if (cov) return cov;
  }
  // crowd tier — viewers' scrub medians count as coverage too (the player
  // shows a working Skip Intro button for them)
  const crowd = await crowdIntroTarget(malId, ep);
  if (crowd != null) return { source: "crowd", intro: { start: 8, end: crowd } };
  return null;
}

/**
 * Warm the live cache ahead of time — called after the catalog sync imports
 * new episodes so their skip data is already on disk before anyone presses
 * play. Sequential with ~1.1s spacing (AniSkip's documented rate limit is
 * 1 req/s); bounded so a huge import can't run away.
 */
export async function prefetchSkipTimes(
  pairs: Array<{ malId: number; ep: number; lenMin?: number | null }>,
  budget = 16,
): Promise<number> {
  let fetched = 0;
  for (const { malId, ep, lenMin } of pairs.slice(0, budget)) {
    try {
      const file = await liveRead(malId);
      const hit = file[String(ep)];
      if (hit && (hit.op || hit.ed || (hit.miss && Date.now() - hit.at < ANISKIP_MISS_TTL_MS))) continue;
      const { times, transient } = await fetchAniSkipLive(malId, ep, lenMin ?? undefined);
      if (!transient) {
        const fresh = await liveRead(malId);
        fresh[String(ep)] = times ? { ...times, at: Date.now() } : { at: Date.now(), miss: true };
        await liveWrite(malId, fresh);
      }
      if (times) fetched++;
    } catch {
      /* keep going */
    }
    await new Promise((r) => setTimeout(r, 1_100)); // respect 1 req/s
  }
  return fetched;
}

/* ------------------------------------------------------------------ *
 * Tier 5 — crowd-learned openings. Brand-new seasons often have NO
 * skip data anywhere (AniSkip 404s for months on niche shows), so the
 * fixed 8-90s guess lands in the middle of their long cold-opens.
 * Instead, viewers who manually scrub forward past the opening get
 * recorded (see POST /api/skip-vote) and the median scrub target
 * becomes this anime's Skip Intro end for everyone. Self-healing:
 * the more people watch, the sharper the button gets.
 * ---------------------------------------------------------------- */

const CROWD_MIN_VOTES_EP = 2; // per-episode median needs at least this many
const CROWD_MIN_VOTES_ANIME = 4; // anime-wide fallback needs more agreement
const CROWD_VOTE_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000; // tastes/encodes drift
const CROWD_KEEP_PER_ANIME = 200; // storage cap per anime

export const SKIP_VOTE_TARGET_MIN = 30;
export const SKIP_VOTE_TARGET_MAX = 420;

/**
 * Record one implied OP-end vote. Best-effort: validates the catalog entry
 * and the target range, caps rows per anime, never throws.
 */
export async function recordSkipVote(malId: number, ep: number, target: number): Promise<boolean> {
  try {
    if (!Number.isFinite(malId) || malId <= 0 || !Number.isFinite(ep) || ep < 1 || ep > 2000) return false;
    if (!Number.isFinite(target)) return false;
    const t = Math.round(target);
    if (t < SKIP_VOTE_TARGET_MIN || t > SKIP_VOTE_TARGET_MAX) return false;
    const anime = await db.anime.findUnique({ where: { malId }, select: { malId: true } });
    if (!anime) return false;
    await db.skipVote.create({ data: { malId, ep, target: t } });
    // prune: keep the newest KEEP votes for this anime (votes are cheap to drop)
    const count = await db.skipVote.count({ where: { malId } });
    if (count > CROWD_KEEP_PER_ANIME) {
      const old = await db.skipVote.findMany({
        where: { malId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: count - CROWD_KEEP_PER_ANIME,
        select: { id: true },
      });
      if (old.length) await db.skipVote.deleteMany({ where: { id: { in: old.map((r) => r.id) } } });
    }
    return true;
  } catch {
    return false;
  }
}

function medianNum(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * The crowd's OP-end for one episode: median of this episode's recent votes,
 * else (with more agreement) the anime-wide median — openings are the same
 * video across episodes. Returns whole seconds or null when thin/old.
 */
export async function crowdIntroTarget(malId: number, ep: number): Promise<number | null> {
  try {
    const from = new Date(Date.now() - CROWD_VOTE_MAX_AGE_MS);
    const rows = await db.skipVote.findMany({
      where: { malId, createdAt: { gte: from } },
      select: { ep: true, target: true },
      orderBy: { createdAt: "desc" },
      take: 400,
    });
    const epTargets = rows.filter((r) => r.ep === ep).map((r) => r.target);
    if (epTargets.length >= CROWD_MIN_VOTES_EP) return medianNum(epTargets);
    const all = rows.map((r) => r.target);
    if (all.length >= CROWD_MIN_VOTES_ANIME) return medianNum(all);
    return null;
  } catch {
    return null;
  }
}
