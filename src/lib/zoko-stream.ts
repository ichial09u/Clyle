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
const cache = new Map<string, CacheEntry>();
const revalidating = new Set<string>();

function cacheKey(malId: number, ep: number, lang: Lang, server: ServerId): string {
  return `${malId}/${ep}/${lang}/${server}`;
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
 * Does Zoko have a DUB stream for this anime at all?
 *   true  = the dub page resolves to a real stream
 *   false = Zoko answered "no" (404 / no payload)
 *   null  = couldn't ask right now (network) — caller should not cache a verdict
 */
export async function probeDubAvailable(malId: number, ep = 1): Promise<boolean | null> {
  try {
    const pageUrl = zokoStreamPageUrl(malId, ep, "dub", "zoko");
    const res = await fetch(pageUrl, {
      headers: {
        "User-Agent": UA,
        Origin: ZOKO_ORIGIN,
        Referer: `${ZOKO_ORIGIN}/`,
        Accept: "text/html,application/xhtml+xml",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
      redirect: "follow",
    });
    if (!res.ok) return false;
    const html = await res.text();
    const m = html.match(/window\.__P="([^"]+)"/);
    if (!m) return false;
    const decoded = decodeStreamPayload(m[1]);
    if (!decoded) return false;
    return !!decoded.src;
  } catch {
    return null;
  }
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
  if (!res.ok) throw new Error(`zoko stream page -> ${res.status}`);
  const html = await res.text();
  const m = html.match(/window\.__P="([^"]+)"/);
  if (!m) throw new Error("no __P payload");
  const decoded = decodeStreamPayload(m[1]);
  if (!decoded) throw new Error("payload decode failed");
  return { ...decoded, resolvedFrom: pageUrl };
}

/**
 * Resolve one episode's direct stream. Cached (memory + disk) with
 * stale-while-revalidate: an expired entry is served immediately while a
 * fresh token is fetched in the background.
 */
export async function resolveStream(
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
    const entry = await diskRead(key);
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
    const entry = await diskRead(key);
    if (entry) return entry.data;
    console.error("[zoko-stream]", err instanceof Error ? err.message : err);
    return null;
  }
}