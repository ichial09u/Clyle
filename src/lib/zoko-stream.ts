/**
 * Server-side Zoko stream resolver.
 *
 * Zoko's stream page (`/stream/mal/{id}/{ep}/{lang}`) embeds an obfuscated
 * player config: `window.__P = base64(xor(json))` with the key
 * "otaku-embed-v1". The decoded JSON carries the direct HLS playlist,
 * subtitle tracks and intro/outro skip data — everything our own player
 * needs to stream WITHOUT loading Zoko's ad-laden page.
 *
 * Server-only: fetches with Zoko's own Origin (their CDN 403s other origins),
 * caches resolutions in memory + on disk with stale-while-error semantics.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zokoStreamPageUrl, type Lang, type ServerId } from "@/lib/zoko";
import { db } from "@/lib/db";
import { getDubAudioVerdict } from "@/lib/dub-audio";

/** Zoko answered with a definitive "this page doesn't exist" (HTTP 404/410). */
export class ZokoNoPageError extends Error {
  constructor(status: number) {
    super(`zoko page -> ${status}`);
    this.name = "ZokoNoPageError";
  }
}

/**
 * The page EXISTS but carries no decodable stream payload — Zoko's dead dub
 * entries do this (a 200 page with no/undecodable __P, e.g. a dub slot that
 * was created for an episode whose dub never actually shipped). Treating it
 * as transient would stall the per-episode dub boundary search forever, so
 * it is DEFINITIVE evidence that no playable stream exists there.
 */
export class ZokoNoStreamError extends Error {
  constructor(reason: string) {
    super(`zoko stream missing: ${reason}`);
    this.name = "ZokoNoStreamError";
  }
}

const OBF_KEY = "otaku-embed-v1";
const ZOKO_ORIGIN = "https://zokoanime.video";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
// Tokenized playlists rotate; keep TTLs short and revalidate in the background.
const TTL_MS = 30 * 60 * 1000;

const DISK_CACHE_DIR =
  process.env.VERCEL === "1" ? join(tmpdir(), "zoko-stream") : join(process.cwd(), "db", "zoko-stream");

export interface ZokoSubtitle {
  lang: string;
  label: string;
  default?: boolean;
  src: string;
}

export interface ZokoStream {
  src: string;
  subtitles: ZokoSubtitle[];
  skip?: {
    intro?: { start: number; end: number };
    outro?: { start: number; end: number };
  };
  videoId?: number;
  resolvedFrom: string;
}

function xor(str: string): string {
  let out = "";
  for (let i = 0; i < str.length; i++) {
    out += String.fromCharCode(str.charCodeAt(i) ^ OBF_KEY.charCodeAt(i % OBF_KEY.length));
  }
  return out;
}

export function decodePayload(blob: string): string | null {
  try {
    const json = JSON.parse(decodeURIComponent(escape(xor(atob(blob))))) as Record<string, unknown>;
    return typeof json.src === "string" ? json.src : null;
  } catch {
    return null;
  }
}

export function decodeStreamPayload(blob: string): Omit<ZokoStream, "resolvedFrom"> | null {
  try {
    const json = JSON.parse(decodeURIComponent(escape(xor(atob(blob))))) as {
      src?: unknown;
      subtitles?: ZokoSubtitle[];
      skip?: ZokoStream["skip"];
      video_id?: number;
    };
    if (typeof json.src !== "string" || !json.src) return null;
    return {
      src: json.src,
      subtitles: Array.isArray(json.subtitles) ? json.subtitles : [],
      skip: json.skip,
      videoId: json.video_id,
    };
  } catch {
    return null;
  }
}

type CacheEntry = { data: ZokoStream | null; expires: number };
/** what diskRead/diskWrite actually require — verdict booleans and streams both fit */
type DiskEntry = { data: unknown; expires: number };
const cache = new Map<string, CacheEntry>();
const revalidating = new Set<string>();

function cacheKey(malId: number, ep: number, lang: Lang, server: ServerId): string {
  return `${malId}/${ep}/${lang}/${server}`;
}

function diskPath(key: string): string {
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 24);
  return join(DISK_CACHE_DIR, `${hash}.json`);
}

async function diskRead(key: string): Promise<DiskEntry | null> {
  try {
    return JSON.parse(await readFile(diskPath(key), "utf8")) as DiskEntry;
  } catch {
    return null;
  }
}

async function diskWrite(key: string, entry: DiskEntry): Promise<void> {
  try {
    await mkdir(DISK_CACHE_DIR, { recursive: true });
    await writeFile(diskPath(key), JSON.stringify(entry), "utf8");
  } catch {
    /* best-effort */
  }
}

/**
 * Does Zoko have a REAL (non-fake) DUB stream for this anime at all?
 *   true  = a dub page resolves AND carries different content than the sub
 *   false = no dub page, or the dub is the sub file re-uploaded
 *   null  = couldn't ask right now (network) — caller should not cache a verdict
 */
export async function probeDubAvailable(malId: number, ep = 1, server: ServerId = "zoko"): Promise<boolean | null> {
  return verifyRealDub(malId, ep, server);
}

async function fetchStream(malId: number, ep: number, lang: Lang, server: ServerId): Promise<ZokoStream | null> {
  const pageUrl = zokoStreamPageUrl(malId, ep, lang, server);
  const res = await fetch(pageUrl, {
    headers: {
      "User-Agent": UA,
      Origin: ZOKO_ORIGIN,
      Referer: `${ZOKO_ORIGIN}/`,
      Accept: "text/html,application/xhtml+xml",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
    redirect: "follow",
  });
  if (res.status === 404 || res.status === 410) {
    // definitive: Zoko has no such page (e.g. no dub uploaded for this
    // episode). Must be distinguished from transient failures below.
    throw new ZokoNoPageError(res.status);
  }
  if (!res.ok) throw new Error(`zoko stream page -> ${res.status}`);
  const html = await res.text();
  const m = html.match(/window\.__P="([^"]+)"/);
  if (!m) throw new ZokoNoStreamError(`no __P payload (${lang})`);
  const decoded = decodeStreamPayload(m[1]);
  if (!decoded) throw new ZokoNoStreamError(`payload decode failed (${lang})`);
  return { ...decoded, resolvedFrom: pageUrl };
}

/* ---- fake-dub detection ----------------------------------------------
 * Zoko sometimes ships a DUB entry whose video is BYTE-IDENTICAL to the SUB
 * (the same Japanese-audio file re-uploaded under a second video id — Blue
 * Box 57181 ep1: video_id 157730 vs 157729, both MD5s equal). Picking DUB
 * then plays Japanese audio under a DUB label.
 *
 * Detection: fetch ONE media segment from each variant playlist and compare
 * digests. Identical bytes -> fake dub. Real dubs mux a different audio
 * track into the same video encode, so their segments always differ.
 * Serverless-safe (plain fetch + sha1, no ffmpeg). The verdict is cached in
 * memory + disk for a day, so the ~4 extra requests are paid once per
 * anime/episode/server per day — Zoko does add real dubs over time.
 * -------------------------------------------------------------------- */
const DUB_CHECK_TTL_MS = 24 * 3600 * 1000;
type DubVerdictEntry = { data: boolean; expires: number };
const dubVerdicts = new Map<string, DubVerdictEntry>(); // true = REAL dub

function dubCheckKey(malId: number, ep: number, server: ServerId): string {
  return `dubcheck/${malId}/${ep}/${server}`;
}

async function cacheDubVerdict(key: string, verdict: boolean): Promise<void> {
  const entry: DubVerdictEntry = { data: verdict, expires: Date.now() + DUB_CHECK_TTL_MS };
  dubVerdicts.set(key, entry);
  await diskWrite(key, entry);
}

/** master m3u8 -> first variant -> absolute URL of its second segment. */
async function firstSegmentUrl(masterUrl: string): Promise<string | null> {
  const headers = { "User-Agent": UA, Origin: ZOKO_ORIGIN, Referer: `${ZOKO_ORIGIN}/` };
  const mres = await fetch(masterUrl, { headers, cache: "no-store", signal: AbortSignal.timeout(12_000) });
  if (!mres.ok) return null;
  const master = await mres.text();
  const variant = master.split("\n").find((l) => l.trim() && !l.startsWith("#"));
  if (!variant) return null;
  const vurl = new URL(variant.trim(), masterUrl).href;
  const vres = await fetch(vurl, { headers, cache: "no-store", signal: AbortSignal.timeout(12_000) });
  if (!vres.ok) return null;
  const vtext = await vres.text();
  // skip the first segment: some uploads prepend a thumbnail/intro card
  const segs = vtext.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  if (segs.length < 2) return null;
  return new URL(segs[1].trim(), vurl).href;
}

async function segmentDigest(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Origin: ZOKO_ORIGIN, Referer: `${ZOKO_ORIGIN}/` },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return createHash("sha1").update(buf).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Does a REAL English dub exist for this episode?
 *   true  = dub stream present AND its content differs from the sub
 *   false = DEFINITIVE no-dub evidence: no dub page at all (HTTP 404), the
 *           dub is the sub's file re-uploaded (fake, identical segments), or
 *           the fleet measured the dub's DECODED AUDIO as identical to the
 *           sub's (the DAN DA DAN case — different video encode, same
 *           Japanese audio muxed in; the raw byte-compare cannot see it)
 *   null  = couldn't tell right now (network trouble / Zoko hiccup) — the
 *           verdict is NOT cached, and the caller must NOT block playback on
 *           it. (Caching a transient failure used to mark real-dub shows as
 *           "no dub" for a day — that's how DUB vanished app-wide.)
 */
export async function verifyRealDub(malId: number, ep: number, server: ServerId): Promise<boolean | null> {
  const key = dubCheckKey(malId, ep, server);
  const mem = dubVerdicts.get(key);
  if (mem && mem.expires > Date.now()) return mem.data;
  const disk = (await diskRead(key)) as unknown as DubVerdictEntry | null;
  if (disk && disk.expires > Date.now() && typeof disk.data === "boolean") {
    dubVerdicts.set(key, disk);
    return disk.data;
  }

  try {
    // fleet-measured audio verdict first — a DB hit, instant and offline.
    // "fake" short-circuits before any network work (the whole point: the
    // DUB page EXISTS and its segments differ, only the language is wrong).
    // "real" skips the byte-compare below — the audio measurement is the
    // stronger evidence.
    const audio = await getDubAudioVerdict(malId, ep, server);
    if (audio === "fake") {
      await cacheDubVerdict(key, false);
      return false;
    }
    if (audio === "real") {
      await cacheDubVerdict(key, true);
      return true;
    }

    // fetch the DUB first: when it is definitively missing we can answer
    // false WITHOUT the sub comparison (faster, and fewer chances for a
    // sub hiccup to mask a definitive dub absence)
    let dub: ZokoStream | null = null;
    let dubMissing = false;
    try {
      dub = await fetchStream(malId, ep, "dub", server);
    } catch (err) {
      if (err instanceof ZokoNoPageError || err instanceof ZokoNoStreamError) {
        dubMissing = true; // no dub page at all, or a dead dub entry
      } else {
        return null; // transient (timeout, 5xx) — do not cache, do not block
      }
    }
    if (dubMissing || !dub) {
      // definitive: no playable dub for this episode
      await cacheDubVerdict(key, false);
      return false;
    }
    const sub = await resolveStreamRaw(malId, ep, "sub", server).catch(() => null); // sub is never verified -> no recursion
    if (!sub) return null; // can't compare — don't guess
    if (sub.src === dub.src) {
      await cacheDubVerdict(key, false); // literally the same stream
      return false;
    }
    const [a, b] = await Promise.all([firstSegmentUrl(sub.src), firstSegmentUrl(dub.src)]);
    if (!a || !b) return null; // network trouble — no verdict
    const [da, dbb] = await Promise.all([segmentDigest(a), segmentDigest(b)]);
    if (da == null || dbb == null) return null; // undecidable — don't block
    const real = da !== dbb;
    await cacheDubVerdict(key, real);
    return real;
  } catch {
    return null;
  }
}

/**
 * Per-server dub verdict for one anime (from the cached ep-1 probes).
 *   true  = a real dub exists on that server
 *   false = probed and definitively absent / fake on that server
 *   null  = not probed yet
 */
export async function dubVerdictFor(malId: number, server: ServerId): Promise<boolean | null> {
  try {
    const anime = await db.anime.findUnique({
      where: { malId },
      select: { hasDub: true, hasDubKiwi: true },
    });
    if (!anime) return null;
    return server === "kiwi" ? (anime.hasDubKiwi ?? null) : (anime.hasDub ?? null);
  } catch {
    return null;
  }
}

/** Best-effort persist of a dub verdict (both servers share Zoko's backend
 *  today, so a verified verdict on one server is recorded for that server). */
export async function storeDubVerdict(malId: number, server: ServerId, verdict: boolean): Promise<void> {
  try {
    const data = server === "kiwi" ? { hasDubKiwi: verdict } : { hasDub: verdict };
    await db.anime.update({ where: { malId }, data }).catch(() => undefined);
  } catch {
    /* verdict persistence is an optimization, never a correctness gate */
  }
}

/**
 * Resolve one episode's direct stream. Cached (memory + disk) with
 * stale-while-revalidate: an expired entry is served immediately while a
 * fresh token is fetched in the background.
 *
 * DUB policy (bring-back-dub fix):
 *  - the per-anime DB verdict (from the cheap ep-1 probe) is the source of
 *    truth for "does a real dub exist",
 *  - verdict false -> null fast (no network, UI hides DUB anyway),
 *  - verdict true  -> resolve and PLAY (no per-play segment compare — that
 *    per-play check turned Zoko hiccups into "no dub" for real-dub shows),
 *  - verdict null  -> one live probe; only DEFINITIVE fake/missing evidence
 *    blocks, a transient hiccup never blocks playback.
 */
export async function resolveStream(
  malId: number,
  ep: number,
  lang: Lang,
  server: ServerId,
  opts: { fresh?: boolean } = {},
): Promise<ZokoStream | null> {
  const data = await resolveStreamRaw(malId, ep, lang, server, opts);
  if (!data || lang !== "dub") return data;

  // Per-episode AUDIO verdict first — it overrides the anime-level columns.
  // A "fake" here means the fleet measured this DUB entry's decoded audio as
  // identical to the SUB's (Japanese audio under a DUB label — DAN DA DAN
  // S1): returning null sends the caller down its backfill chain to a real
  // English source. A "real" is equally decisive in the other direction —
  // the anime-level columns describe the ep-1 probe only, so DAN DA DAN's
  // fake ep1 flips hasDub/hasDubKiwi to false and would wrongly block eps
  // 2-12, whose dubs the fleet measured as real English. Per-episode proof
  // beats per-anime staleness in BOTH directions.
  const audio = await getDubAudioVerdict(malId, ep, server);
  if (audio === "fake") return null;
  if (audio === "real") return data;

  const verdict = await dubVerdictFor(malId, server);
  if (verdict === true) return data;
  if (verdict === false) return null;

  // unknown: probe once (this caches into the dubcheck disk cache too)
  const real = await verifyRealDub(malId, ep, server);
  if (real === false) {
    void storeDubVerdict(malId, server, false);
    return null;
  }
  if (real === true) void storeDubVerdict(malId, server, true);
  return data; // real, or undecidable -> never block playback on a hiccup
}

async function resolveStreamRaw(
  malId: number,
  ep: number,
  lang: Lang,
  server: ServerId,
  opts: { fresh?: boolean } = {},
): Promise<ZokoStream | null> {
  const key = cacheKey(malId, ep, lang, server);
  const hit = cache.get(key);
  if (!opts.fresh && hit && hit.expires > Date.now()) return hit.data;

  if (!opts.fresh) {
    // stream-cache keys always store ZokoStream data (dubcheck keys store
    // booleans — they go through verifyRealDub's own narrowing)
    const entry = (await diskRead(key)) as CacheEntry | null;
    if (entry) {
      if (entry.expires > Date.now()) {
        cache.set(key, entry);
        return entry.data;
      }
      // serve stale now, refresh quietly
      if (!revalidating.has(key)) {
        revalidating.add(key);
        void fetchStream(malId, ep, lang, server)
          .then((data) => {
            const fresh: CacheEntry = { data, expires: Date.now() + TTL_MS };
            cache.set(key, fresh);
            return diskWrite(key, fresh);
          })
          .catch(() => undefined)
          .finally(() => revalidating.delete(key));
      }
      cache.set(key, entry);
      return entry.data;
    }
  }

  try {
    const data = await fetchStream(malId, ep, lang, server);
    const entry: CacheEntry = { data, expires: Date.now() + TTL_MS };
    cache.set(key, entry);
    void diskWrite(key, entry);
    return data;
  } catch (err) {
    const stale = cache.get(key);
    if (stale) return stale.data;
    const entry = (await diskRead(key)) as CacheEntry | null;
    if (entry) return entry.data;
    console.error("[zoko-stream]", err instanceof Error ? err.message : err);
    return null;
  }
}