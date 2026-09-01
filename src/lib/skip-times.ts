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
  source?: "zoko" | "aniskip" | "aniskip-live" | "crowd";
}

type EpisodeEntry = { op?: [number, number]; ed?: [number, number] };
type Dataset = Record<string, Record<string, EpisodeEntry>>;

const data = skipDataset as unknown as Dataset;

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

function valid(iv: unknown): iv is SkipInterval {
  if (!iv || typeof iv !== "object") return false;
  const v = iv as SkipInterval;
  return Number.isFinite(v.start) && Number.isFinite(v.end) && v.end > v.start;
}

/**
 * Merge Zoko's native skip payload with the AniSkip dataset.
 * Zoko wins per-field (it is frame-accurate for its own encodes);
 * the dataset fills whatever Zoko left blank.
 */
export function withSkipData<T extends { skip?: SkipData }>(malId: number, ep: number, stream: T): T & { skip?: SkipData } {
  const zoko = stream.skip ?? {};
  const filled = lookupSkipTimes(malId, ep);

  const merged: SkipData = {};
  const intro = valid(zoko.intro) ? zoko.intro : valid(filled.intro) ? filled.intro : undefined;
  const outro = valid(zoko.outro) ? zoko.outro : valid(filled.outro) ? filled.outro : undefined;
  if (intro) merged.intro = intro;
  if (outro) merged.outro = outro;
  if (intro || outro) {
    merged.source = valid(zoko.intro) || valid(zoko.outro) ? "zoko" : "aniskip";
  }

  return { ...stream, skip: Object.keys(merged).length ? merged : undefined };
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
  const merged = withSkipData(malId, ep, stream);
  if (merged.skip?.intro && merged.skip?.outro) return merged; // nothing to ask
  try {
    const live = await liveLookup(malId, ep, opts.episodeLengthMin ?? undefined);
    if (live) {
      const skip: SkipData = { ...(merged.skip ?? {}) };
      if (!skip.intro && live.op) skip.intro = { start: live.op[0], end: live.op[1] };
      if (!skip.outro && live.ed) skip.outro = { start: live.ed[0], end: live.ed[1] };
      if (skip.intro || skip.outro) {
        skip.source = merged.skip?.source ?? "aniskip-live";
        return { ...merged, skip };
      }
    }
  } catch {
    /* live tier is best-effort — the crowd/heuristic tiers still cover episodes */
  }
  // crowd tier — for shows nobody has submitted anywhere yet, viewers who
  // scrubbed past the opening have already taught us where it ends
  try {
    const crowd = await crowdIntroTarget(malId, ep);
    if (crowd != null) {
      const skip: SkipData = { ...(merged.skip ?? {}) };
      if (!skip.intro) skip.intro = { start: 8, end: crowd };
      if (skip.intro || skip.outro) {
        skip.source = merged.skip?.source ?? "crowd";
        return { ...merged, skip };
      }
    }
  } catch {
    /* votes are best-effort too */
  }
  return merged;
}

/**
 * Coverage check used by the skip audit (bot): where would this episode's
 * Skip Intro data come from? Checks the vendored dataset (exact row, then
 * per-anime consensus), then the live tier's cache — `allowLiveFetch` also
 * permits one cached network query to AniSkip (used when probing gaps).
 */
export interface SkipCoverage {
  intro?: SkipInterval;
  outro?: SkipInterval;
  source: "exact" | "consensus" | "live";
}

export async function skipCoverage(
  malId: number,
  ep: number,
  opts: { allowLiveFetch?: boolean; episodeLengthMin?: number | null } = {},
): Promise<SkipCoverage | null> {
  const byEp = data[String(malId)];
  const exact = byEp?.[String(ep)];
  if (exact?.op || exact?.ed) {
    const cov: SkipCoverage = { source: "exact" };
    if (exact.op) cov.intro = { start: exact.op[0], end: exact.op[1] };
    if (exact.ed) cov.outro = { start: exact.ed[0], end: exact.ed[1] };
    return cov;
  }
  const cons = consensus(malId);
  if (cons.op || cons.ed) {
    const cov: SkipCoverage = { source: "consensus" };
    if (cons.op) cov.intro = { start: cons.op[0], end: cons.op[1] };
    if (cons.ed) cov.outro = { start: cons.ed[0], end: cons.ed[1] };
    return cov;
  }
  if (opts.allowLiveFetch) {
    const live = await liveLookup(malId, ep, opts.episodeLengthMin ?? undefined);
    if (live?.op || live?.ed) {
      const cov: SkipCoverage = { source: "live" };
      if (live.op) cov.intro = { start: live.op[0], end: live.op[1] };
      if (live.ed) cov.outro = { start: live.ed[0], end: live.ed[1] };
      return cov;
    }
    return null;
  }
  const cached = (await liveRead(malId))[String(ep)];
  if (cached && !cached.miss && (cached.op || cached.ed)) {
    const cov: SkipCoverage = { source: "live" };
    if (cached.op) cov.intro = { start: cached.op[0], end: cached.op[1] };
    if (cached.ed) cov.outro = { start: cached.ed[0], end: cached.ed[1] };
    return cov;
  }
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
