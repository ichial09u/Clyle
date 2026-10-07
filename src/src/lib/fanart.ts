/**
 * fanart.tv title-logo (clearlogo) enrichment.
 *
 * fanart.tv hosts community-maintained official title logos as transparent
 * PNGs — the artwork that makes Netflix-style "title inside the poster"
 * cards. Their API keys off TheTVDB ids, so we map MAL -> TVDB via the
 * anime-lists.org community mapping file (the same one Jellyfin uses).
 *
 * Requires a free personal API key (https://fanart.tv/get-an-api-key/)
 * provided as FANART_API_KEY. Without it, callers should treat this module
 * as inactive — logos can still be seeded directly into Anime.logoUrl.
 *
 * Everything is cached aggressively:
 *  - the MAL->TVDB mapping file: fetched once, kept on disk (it's ~2MB and
 *    refreshes weekly at most)
 *  - per-TVDB-id API answers: in-memory + disk, 30 days (fanart data is
 *    append-mostly)
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_BASE = "https://webservice.fanart.tv/v3/tv";
const MAPPING_URL =
  "https://raw.githubusercontent.com/Anime-Lists/anime-lists/master/anime-list-full.xml";
const MAPPING_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 2 weeks
const LOGO_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const CACHE_DIR =
  process.env.VERCEL === "1" ? join(tmpdir(), "fanart") : join(process.cwd(), "db", "fanart");

export function fanartEnabled(): boolean {
  return Boolean(process.env.FANART_API_KEY);
}

/* ---------------- MAL -> TVDB mapping ---------------- */

type MappingIndex = Map<number, number>; // malId -> tvdbId
let mapping: MappingIndex | null = null;
let mappingLoadedAt = 0;

/**
 * The mapping file is a flat <anime> XML list:
 *   <anime anidbid="..." tvdbid="82681" tmdbid="" malid="21" .../>
 * Parse only what we need (malid + tvdbid), skipping "unknown"/"" entries.
 */
function parseMapping(xml: string): MappingIndex {
  const out: MappingIndex = new Map();
  const re = /<anime\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const tag = m[0];
    const mal = /(?:^|\s)malid="(\d+)"/.exec(tag);
    const tvdb = /(?:^|\s)tvdbid="(\d+)"/.exec(tag);
    if (mal && tvdb) out.set(Number(mal[1]), Number(tvdb[1]));
  }
  return out;
}

async function loadMapping(): Promise<MappingIndex | null> {
  if (mapping && Date.now() - mappingLoadedAt < MAPPING_TTL_MS) return mapping;
  const cached = join(CACHE_DIR, "anime-list-full.xml");
  try {
    const stat = await readFile(cached, "utf8");
    // treat disk cache as fresh when it exists and was written < TTL ago is
    // unknowable from content alone; refetch failures fall back to it anyway
    mapping = parseMapping(stat);
    mappingLoadedAt = Date.now();
    return mapping;
  } catch {
    /* no disk cache yet */
  }
  try {
    const res = await fetch(MAPPING_URL, { signal: AbortSignal.timeout(30_000), cache: "no-store" });
    if (!res.ok) return mapping;
    const xml = await res.text();
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cached, xml, "utf8");
    mapping = parseMapping(xml);
    mappingLoadedAt = Date.now();
    return mapping;
  } catch {
    return mapping; // keep whatever we had
  }
}

/* ---------------- fanart.tv API (cached) ---------------- */

interface FanartTv {
  [kind: string]: { url: string; lang: string; likes?: string }[] | unknown;
}

async function fetchTvFanart(tvdbId: number): Promise<FanartTv | null> {
  const key = process.env.FANART_API_KEY;
  if (!key) return null;
  const memKey = `tv-${tvdbId}`;
  const disk = join(CACHE_DIR, `${memKey}.json`);
  try {
    const hit = JSON.parse(await readFile(disk, "utf8")) as { expires: number; data: FanartTv };
    if (hit.expires > Date.now()) return hit.data;
  } catch {
    /* miss */
  }
  try {
    const res = await fetch(`${API_BASE}/${tvdbId}?api_key=${encodeURIComponent(key)}`, {
      headers: { "User-Agent": "Clyle/1.0 (anime web app)" },
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as FanartTv;
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(disk, JSON.stringify({ expires: Date.now() + LOGO_TTL_MS, data }), "utf8");
    return data;
  } catch {
    return null;
  }
}

/**
 * Best clearlogo for a show: English, then any language; the HD variant when
 * present. fanart sorts by popularity internally — we take their order.
 */
function pickLogo(data: FanartTv | null): string | null {
  if (!data) return null;
  const hd = (data.hdtvlogo ?? []) as { url: string; lang: string }[];
  const plain = (data.clearlogo ?? []) as { url: string; lang: string }[];
  const pool = [...hd, ...plain].filter((l) => l?.url);
  const en = pool.find((l) => (l.lang ?? "").toLowerCase().startsWith("en"));
  return (en ?? pool[0])?.url ?? null;
}

/**
 * Resolve the official clearlogo for a MAL id, or null when fanart.tv has no
 * entry / no key is configured / anything fails. Never throws.
 */
export async function fanartLogoFor(malId: number): Promise<string | null> {
  try {
    if (!fanartEnabled()) return null;
    const map = await loadMapping();
    const tvdbId = map?.get(malId);
    if (!tvdbId) return null;
    return pickLogo(await fetchTvFanart(tvdbId));
  } catch {
    return null;
  }
}
