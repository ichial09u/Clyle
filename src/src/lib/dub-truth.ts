/**
 * DUB truth check — is Zoko's "dub" entry actually a separate English-audio
 * stream, or a silent copy of the sub stream?
 *
 * WHY: Zoko registers a "dub" video entry for many shows, but the entry is
 * frequently a byte-identical copy of the sub stream (verified: Blue Box ep1
 * and FMA:B ep1 served identical TS segments for SUB and DUB; the HLS
 * playlists carry no audio-language tags). Picking "DUB" on those shows
 * replays the Japanese audio while the UI claims dub — the exact bug report
 * this file fixes.
 *
 * HOW (pure JS, Vercel-safe — no ffmpeg):
 *   1. resolve both streams via resolveStream (cached)
 *   2. no dub payload at all            -> "none"
 *   3. first 192KB of the 720p segment
 *      byte-identical (and same total)  -> "fake"  (same content, not a dub)
 *   4. anything else                    -> "real" (distinct encode; spoken
 *      language can't be verified without audio analysis — best effort)
 *
 * Verdicts are cached in memory + disk for 24h (dub lineups change rarely);
 * null means "couldn't ask right now" and is never cached.
 */

import { resolveStream, type ZokoStream } from "./zoko-stream";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerId } from "./zoko";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const HEAD_BYTES = 192 * 1024; // 192KB of the first segment — plenty to fingerprint
const TTL_MS = 24 * 60 * 60 * 1000;

const DISK_CACHE_DIR =
  process.env.VERCEL === "1" ? join(tmpdir(), "dub-truth") : join(process.cwd(), "db", "dub-truth");

export type DubVerdict = "real" | "fake" | "none";

function zokoHeaders(): Record<string, string> {
  return {
    "User-Agent": UA,
    Origin: "https://zokoanime.video",
    Referer: "https://zokoanime.video/",
  };
}

/** Head of the first media segment of a variant playlist. */
async function firstSegHead(variant: { url: string; text: string }): Promise<{ head: Buffer; total: number } | null> {
  const seg = variant.text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  if (!seg) return null;
  const segUrl = new URL(seg, variant.url).href;
  const segRes = await fetch(segUrl, {
    headers: { ...zokoHeaders(), Range: `bytes=0-${HEAD_BYTES - 1}` },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!segRes.ok && segRes.status !== 206) return null;
  const buf = Buffer.from(await segRes.arrayBuffer());
  if (!buf.length) return null;
  // total size from "bytes 0-N/M" (falls back to buf length when unbounded)
  const cr = segRes.headers.get("content-range");
  const total = cr ? parseInt(cr.split("/")[1] ?? "", 10) : buf.length;
  return { head: buf, total: Number.isFinite(total) ? total : buf.length };
}

type Fingerprint = { sha1: string; total: number };

/** master + 720p (or middle) variant text in one pass */
async function variantText(masterUrl: string): Promise<{ url: string; text: string } | null> {
  const res = await fetch(masterUrl, {
    headers: zokoHeaders(),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const lines = (await res.text()).split("\n").map((l) => l.trim());
  let variant: string | null = null;
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].startsWith("#EXT-X-STREAM-INF") && lines[i].includes("1280x720")) {
      variant = lines[i + 1];
      break;
    }
  }
  if (!variant) {
    const list = lines.filter((l, i) => l && !l.startsWith("#") && lines[i - 1]?.startsWith("#EXT-X-STREAM-INF"));
    if (!list.length) return null;
    variant = list[Math.floor(list.length / 2)];
  }
  const variantUrl = new URL(variant, masterUrl).href;
  const plRes = await fetch(variantUrl, {
    headers: zokoHeaders(),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!plRes.ok) return null;
  return { url: variantUrl, text: await plRes.text() };
}

async function fingerprint(stream: ZokoStream): Promise<{ variant: { url: string; text: string }; fp: Fingerprint } | null> {
  try {
    if (!stream.src.includes("/master.m3u8")) return null; // unexpected shape — skip
    const variant = await variantText(stream.src);
    if (!variant) return null;
    const fp = await firstSegHead(variant);
    if (!fp) return null;
    return { variant, fp: { sha1: createHash("sha1").update(fp.head).digest("hex"), total: fp.total } };
  } catch {
    return null;
  }
}

// ---- verdict cache (memory + disk), 24h ----
type CacheEntry = { verdict: DubVerdict; expires: number };
const cache = new Map<string, CacheEntry>();

function cacheKey(malId: number, ep: number, server: ServerId): string {
  return `${malId}/${ep}/${server}`;
}

function diskPath(key: string): string {
  return join(DISK_CACHE_DIR, `${createHash("sha1").update(key).digest("hex").slice(0, 24)}.json`);
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

export async function cachedDubVerdict(malId: number, ep: number, server: ServerId): Promise<DubVerdict | null> {
  const key = cacheKey(malId, ep, server);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.verdict;
  const entry = await diskRead(key);
  if (entry && entry.expires > Date.now()) {
    cache.set(key, entry);
    return entry.verdict;
  }
  return null;
}

async function cacheVerdict(malId: number, ep: number, server: ServerId, verdict: DubVerdict): Promise<void> {
  const key = cacheKey(malId, ep, server);
  const entry: CacheEntry = { verdict, expires: Date.now() + TTL_MS };
  cache.set(key, entry);
  void diskWrite(key, entry);
}

/**
 * Truth verdict for one episode's dub. "fake" means playing DUB would replay
 * the SUB content; "none" means no dub entry exists; "real" means a distinct
 * dub encode exists (audio language unverified); null = network trouble.
 */
export async function checkDubTruth(malId: number, ep: number, server: ServerId = "zoko"): Promise<DubVerdict | null> {
  const cached = await cachedDubVerdict(malId, ep, server);
  if (cached) return cached;

  let sub: ZokoStream | null = null;
  let dub: ZokoStream | null = null;
  try {
    [sub, dub] = await Promise.all([
      resolveStream(malId, ep, "sub", server),
      resolveStream(malId, ep, "dub", server),
    ]);
  } catch {
    return null;
  }
  if (!dub) {
    if (sub) {
      await cacheVerdict(malId, ep, server, "none");
      return "none";
    }
    return null; // neither resolved — network trouble, don't cache
  }
  if (!sub) return null;

  const [fSub, fDub] = await Promise.all([fingerprint(sub), fingerprint(dub)]);
  if (!fSub || !fDub) return null; // couldn't fingerprint — don't guess

  // identical variant playlists (segment names + EXTINF durations) or
  // identical segment bytes -> the "dub" is the sub content
  const samePlaylist = fSub.variant.text === fDub.variant.text;
  const sameBytes = fSub.fp.sha1 === fDub.fp.sha1 && fSub.fp.total === fDub.fp.total;
  const verdict: DubVerdict = samePlaylist || sameBytes ? "fake" : "real";
  await cacheVerdict(malId, ep, server, verdict);
  return verdict;
}

/**
 * One-shot per-anime dub availability (used by the episodes API).
 * Probes episode 1 and persists nothing here — the caller stores it on the
 * Anime row. Returns null when the network wouldn't answer.
 */
export async function probeDubTruth(malId: number, server: ServerId = "zoko"): Promise<DubVerdict | null> {
  return checkDubTruth(malId, 1, server);
}
