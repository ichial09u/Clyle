/**
 * Per-episode REAL quality (resolution ladder).
 *
 * Owner report: old shows are marked 1080p when their early episodes are
 * actually 360p — Zoko's player chrome and our download dialog both used to
 * assume every episode ships 360p/720p/1080p. The truth lives in the master
 * playlist's `#EXT-X-STREAM-INF:...,RESOLUTION=WxH` attributes.
 *
 * Resolution sources, in order:
 *   1. the quality FLEET (scripts/quality-fleet.mjs) pre-measures every
 *      episode and stores the height list on the Episode row (`qualities`)
 *   2. a runtime parse of the master playlist (one small fetch) — persisted
 *      back to the Episode row so the runtime cost is paid at most once per
 *      episode per instance
 *   3. null — the caller falls back to the classic 3-option list
 *
 * DUB episodes have no Episode row (Episode rows are sub-keyed today), so
 * dub verdicts live in a small in-memory cache for the instance's life.
 */
import { db } from "@/lib/db";

const ZOKO_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const dubCache = new Map<string, number[]>();
const DUB_CACHE_MAX = 4000;

function parseHeights(master: string): number[] {
  const out = new Set<number>();
  for (const line of master.split("\n")) {
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
    const m = line.match(/RESOLUTION\s*=\s*(\d+)\s*x\s*(\d+)/i);
    if (m) {
      const h = parseInt(m[2], 10);
      if (h > 0) out.add(h);
    }
  }
  return [...out].sort((a, b) => b - a);
}

async function fetchMasterText(masterUrl: string, referer?: string | null): Promise<string | null> {
  try {
    const headers: Record<string, string> = { "User-Agent": ZOKO_UA };
    // Zoko's CDN 403s foreign origins — speak as Zoko itself; backup sources
    // get their own referer riding along
    try {
      headers.Origin = new URL(masterUrl).origin;
    } catch {
      /* unparseable — the fetch will fail and we return null */
    }
    if (referer) headers.Referer = referer;
    const res = await fetch(masterUrl, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(7_000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function rememberDub(key: string, heights: number[] | null) {
  if (heights && heights.length) {
    if (dubCache.size >= DUB_CACHE_MAX) {
      const first = dubCache.keys().next().value;
      if (first) dubCache.delete(first);
    }
    dubCache.set(key, heights);
  }
}

/**
 * Real heights for one episode, [] = source carries no resolution info,
 * null = unknown (caller falls back to the classic ladder).
 */
export async function episodeHeights(
  malId: number,
  ep: number,
  lang: "sub" | "dub",
  masterUrl: string | null | undefined,
  referer?: string | null,
): Promise<number[] | null> {
  // 1) fleet measurements first (instant, offline)
  if (lang === "sub") {
    try {
      const row = await db.episode.findUnique({
        where: { animeId_number_lang: { animeId: malId, number: ep, lang: "sub" } },
        select: { qualities: true },
      });
      if (row?.qualities) {
        const parsed = JSON.parse(row.qualities) as unknown;
        if (Array.isArray(parsed) && parsed.length && parsed.every((n) => typeof n === "number")) {
          return [...(parsed as number[])].sort((a, b) => b - a);
        }
      }
    } catch {
      /* fall through to runtime parse */
    }
  } else {
    const hit = dubCache.get(`${malId}/${ep}`);
    if (hit) return [...hit];
  }

  // 2) runtime parse — only for direct URLs (the proxy-served synthesized
  //    masters (FlixCloud) and backfill providers without referers can't be
  //    pulled with these headers)
  if (!masterUrl || !/^https?:\/\//i.test(masterUrl)) return null;
  const text = await fetchMasterText(masterUrl, referer);
  if (!text) return null;
  const heights = parseHeights(text);
  if (!heights.length) return [];

  // 3) persist so future plays never pay the fetch (sub rows) / instance cache (dub)
  if (lang === "sub") {
    try {
      await db.episode.updateMany({
        where: { animeId: malId, number: ep, lang: "sub" },
        data: { qualities: JSON.stringify(heights) },
      });
    } catch {
      /* best effort */
    }
  } else {
    rememberDub(`${malId}/${ep}`, heights);
  }
  return heights;
}
