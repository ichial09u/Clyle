/**
 * Megaplay DUB resolver — the "yenime" backend (api.flikhub.net).
 *
 * Yenime's embed player is a thin skin over flikhub's megaplay extraction:
 *   GET https://api.flikhub.net/megaplay?mal={malId}&ep={ep}&type=dub
 *     -> { m3u8, proxiedUrl, tracks:[{file,label,kind,default}] }
 * The m3u8 hosts (megap.shiora.top / megap.norami.top / ncdn.kryntal.top / …)
 * all require `Referer: https://megaplay.buzz/` — our /api/stream/proxy
 * injects that for the hosts registered here.
 *
 * DUB ONLY. The user's instruction: use these backfill sources for the DUB
 * language only — SUB keeps flowing through Zoko/Kiwi untouched.
 *
 * Fake-dub detection (megaplay edition): megaplay serves a "dub" playlist
 * even for episodes that have no dub — but the stub playlist contains ONLY
 * ad-image segments (tiktokcdn URLs, zero real video segments), while a real
 * dub's variant playlist is full of `seg-N-f1-v1-a1.ts` media segments.
 * Counting real segment lines settles it in two small text fetches.
 *
 * Server-only. Mirrors zoko-stream's cache shapes (memory + disk,
 * stale-while-error) so behaviour stays consistent across providers.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@/lib/db";
import { allowHostWithReferer, MEGAPLAY_REFERER } from "@/lib/stream-proxy-registry";

const FLIKHUB = "https://api.flikhub.net";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const TTL_MS = 30 * 60 * 1000; // megaplay token URLs rotate — same short TTL as Zoko
const DUB_CHECK_TTL_MS = 24 * 3600 * 1000;

const DISK_CACHE_DIR =
  process.env.VERCEL === "1" ? join(tmpdir(), "megaplay") : join(process.cwd(), "db", "megaplay");

export interface MegaplayStream {
  src: string;
  subtitles: Array<{ lang: string; label: string; default?: boolean; src: string }>;
  resolvedFrom: string;
}

type CacheEntry = { data: MegaplayStream | null; expires: number };
type VerdictEntry = { data: boolean; expires: number };
const cache = new Map<string, CacheEntry>();
const verdicts = new Map<string, VerdictEntry>();
const inFlight = new Map<string, Promise<MegaplayStream | null>>();

function diskPath(key: string): string {
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 24);
  return join(DISK_CACHE_DIR, `${hash}.json`);
}

async function diskRead<T>(key: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(diskPath(key), "utf8")) as T;
  } catch {
    return null;
  }
}

async function diskWrite(key: string, entry: unknown): Promise<void> {
  try {
    await mkdir(DISK_CACHE_DIR, { recursive: true });
    await writeFile(diskPath(key), JSON.stringify(entry), "utf8");
  } catch {
    /* best-effort */
  }
}

/** Register every host a megaplay stream needs with the megaplay referer. */
function registerStreamHosts(stream: MegaplayStream): void {
  for (const url of [stream.src, ...stream.subtitles.map((s) => s.src)]) {
    try {
      allowHostWithReferer(new URL(url).hostname, MEGAPLAY_REFERER);
    } catch {
      /* ignore */
    }
  }
}

async function resolveMegaplayDubRaw(malId: number, ep: number): Promise<MegaplayStream | null> {
  const res = await fetch(`${FLIKHUB}/megaplay?mal=${malId}&ep=${ep}&type=dub`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`flikhub megaplay -> ${res.status}`);
  const json = (await res.json()) as {
    m3u8?: string;
    tracks?: Array<{ file?: string; label?: string; kind?: string; default?: boolean }>;
  };
  if (!json.m3u8) return null; // definitive: no dub stream for this episode
  const stream: MegaplayStream = {
    src: json.m3u8,
    subtitles: (json.tracks ?? [])
      .filter((t) => (t.kind ?? "captions") === "captions" && t.file)
      .map((t) => ({
        lang: "en",
        label: t.label || "English",
        default: t.default === true,
        src: t.file as string,
      })),
    resolvedFrom: `${FLIKHUB}/megaplay?mal=${malId}&ep=${ep}&type=dub`,
  };
  registerStreamHosts(stream);
  return stream;
}

/**
 * Resolve the megaplay DUB stream for one episode (HLS). Null = no dub here.
 * Cached 30 min (memory + disk) — token URLs rotate like Zoko's.
 */
export async function megaplayDub(
  malId: number,
  ep: number,
  opts: { fresh?: boolean } = {},
): Promise<MegaplayStream | null> {
  const key = `stream/${malId}/${ep}`;
  if (!opts.fresh) {
    const mem = cache.get(key);
    if (mem && mem.expires > Date.now()) return mem.data;
    const disk = (await diskRead<CacheEntry>(key)) as CacheEntry | null;
    if (disk && disk.expires > Date.now()) {
      cache.set(key, disk);
      if (disk.data) registerStreamHosts(disk.data);
      return disk.data;
    }
  }

  const existing = inFlight.get(key);
  if (existing) return existing;

  const job = (async () => {
    try {
      const data = await resolveMegaplayDubRaw(malId, ep);
      const entry: CacheEntry = { data, expires: Date.now() + TTL_MS };
      cache.set(key, entry);
      void diskWrite(key, entry);
      return data;
    } catch (err) {
      // transient (timeout / 5xx): serve stale if we have it, never a fake "no dub"
      const stale = cache.get(key) ?? (await diskRead<CacheEntry>(key));
      if (stale) return stale.data;
      console.error("[megaplay]", err instanceof Error ? err.message : err);
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, job);
  return job;
}

/* ---- fake-dub verification (ad-stub detector) ------------------------- */

function dubCheckKey(malId: number, ep: number): string {
  return `dubcheck/${malId}/${ep}`;
}

async function cacheVerdict(key: string, verdict: boolean): Promise<void> {
  const entry: VerdictEntry = { data: verdict, expires: Date.now() + DUB_CHECK_TTL_MS };
  verdicts.set(key, entry);
  await diskWrite(key, entry);
}

/** master m3u8 -> first variant -> count REAL video segment lines. */
async function realSegmentCount(masterUrl: string): Promise<number | null> {
  const headers = { "User-Agent": UA, Referer: MEGAPLAY_REFERER, Accept: "*/*" };
  const mres = await fetch(masterUrl, { headers, cache: "no-store", signal: AbortSignal.timeout(12_000) });
  if (!mres.ok) return null;
  const master = await mres.text();
  const variant = master.split("\n").find((l) => l.trim() && !l.startsWith("#"));
  if (!variant) return 0;
  const vurl = new URL(variant.trim(), masterUrl).href;
  const vres = await fetch(vurl, { headers, cache: "no-store", signal: AbortSignal.timeout(12_000) });
  if (!vres.ok) return null;
  const vtext = await vres.text();
  // real media segments live on the anime CDN path (`seg-N-…`); megaplay's
  // fake-dub stubs are 100% tiktokcdn ad-image lines with zero such segments
  return vtext
    .split("\n")
    .filter((l) => {
      const s = l.trim();
      return s && !s.startsWith("#") && /seg-\d+-/.test(s) && !/tiktokcdn\.com/.test(s);
    }).length;
}

/**
 * Does a REAL English dub exist for this episode on megaplay?
 *   true  = dub playlist carries real video segments
 *   false = DEFINITIVE no-dub evidence: no m3u8 at all, or the ad-stub
 *           playlist (zero real segments) megaplay serves for undubbed eps
 *   null  = couldn't tell right now (network) — never cached, never blocking
 */
export async function verifyRealMegaplayDub(malId: number, ep: number): Promise<boolean | null> {
  const key = dubCheckKey(malId, ep);
  const mem = verdicts.get(key);
  if (mem && mem.expires > Date.now()) return mem.data;
  const disk = (await diskRead<VerdictEntry>(key)) as VerdictEntry | null;
  if (disk && disk.expires > Date.now() && typeof disk.data === "boolean") {
    verdicts.set(key, disk);
    return disk.data;
  }

  try {
    const stream = await megaplayDub(malId, ep);
    if (!stream) {
      await cacheVerdict(key, false); // flikhub answered cleanly: no dub stream
      return false;
    }
    const count = await realSegmentCount(stream.src);
    if (count == null) return null; // network trouble — no verdict
    const real = count >= 3; // a real episode has hundreds; stubs have 0
    await cacheVerdict(key, real);
    return real;
  } catch {
    return null;
  }
}

/** Per-anime probe used by the episodes route (verdict at ep 1). */
export async function probeMegaplayDub(malId: number, ep = 1): Promise<boolean | null> {
  return verifyRealMegaplayDub(malId, ep);
}

/** Persist the per-anime megaplay dub verdict (optimization, never a gate). */
export async function storeMegaplayVerdict(malId: number, verdict: boolean): Promise<void> {
  try {
    await db.anime.update({ where: { malId }, data: { hasDubMega: verdict } }).catch(() => undefined);
  } catch {
    /* best-effort */
  }
}
