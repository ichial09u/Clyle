/**
 * Anivexa API — the BACKUP DUB network (Server #3+).
 *
 * The user's ask: "Add backup player iframes for animes that has dub but we
 * don't have yet like myapi / AnimePahe API, Anivexa API, and Aniwatch API —
 * whoever has that dub gets their server and if only 1 has it only had 1
 * dub button."
 *
 * Anivexa (github.com/walterwhite-69/Anivexa-API) is a streaming aggregator
 * keyed on the AniList id: it fronts a dozen providers (AniNeko, AnimeGG,
 * HiAnime — the Aniwatch API's source — AllManga, Reanime, AniKoto, ...)
 * and answers BOTH of the questions we need:
 *
 *   GET /episodes/:anilistId          per-provider sub/dub episode lists
 *                                     (dub coverage = "does this server
 *                                     have THAT dub?")
 *   GET /watch/:provider/:anilistId/sub|dub/:provider-:ep
 *                                     direct HLS streams for one episode
 *
 * We play the resolved HLS in OUR OWN player (not a raw iframe) so skip
 * intro, the watermark, Continue Watching and Chromecast all keep working —
 * the "backup player" behaves exactly like Zoko/Kiwi, it just resolves from
 * a different network when Zoko/Kiwi carry no real dub.
 *
 * Honesty rules carried over from the Edgerunners case:
 *  - Only providers whose dub list actually CONTAINS the episode get DUB
 *    buttons (per-episode gating — "if only 1 has it, only 1 dub button").
 *  - A wrong-provider-match guard drops providers whose cached title
 *    doesn't match our anime (Anivexa's animegg once answered a Cyberpunk
 *    Edgerunners lookup with "Bocchi the Rock!" — that never reaches our UI).
 *  - Every stream is playlist-validated at resolve time; dead backends
 *    (AniNeko's storage had a 403 day) are skipped in favor of the next
 *    provider, and if nobody answers the chain falls back to the existing
 *    SupaPlay/Yenime/megaplay-embed sources.
 *
 * AnimePahe ("myapi / AnimePahe API") is NOT integrated: animepahe.ru sits
 * behind DDoS-Guard which blocks datacenter egress (even Anivexa's own
 * animepahe provider errors with "DDoS-Guard clearance cookie missing"), so
 * no reliable stream can come out of it from our infrastructure.
 *
 * Server-side only (uses fs disk cache like lib/anilist.ts).
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaByMal } from "@/lib/anilist";
import { getDubAudioVerdict } from "@/lib/dub-audio";
import {
  ANIVEXA_PROVIDERS,
  BACKUP_PROVIDER_NAMES,
  backupServerId,
  type AnivexaProvider,
} from "@/lib/backup-servers";

export { ANIVEXA_PROVIDERS, BACKUP_PROVIDER_NAMES };
export type { AnivexaProvider };

const BASE = (process.env.ANIVEXA_API_BASE || "https://anivexa-api.vercel.app").replace(/\/+$/, "");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/* ------------------------------ disk cache ------------------------------ */

const DISK_CACHE_DIR =
  process.env.VERCEL === "1"
    ? join(tmpdir(), "anivexa-cache")
    : join(process.cwd(), "db", "anivexa-cache");

const EPS_TTL_MS = 24 * 3600 * 1000; // per-provider episode lists — stale-while-error
const WATCH_TTL_MS = 30 * 60 * 1000; // resolved streams — short (upstreams rotate)
const NEG_TTL_MS = 2 * 3600 * 1000; // provider said "not found" — don't hammer it

type Entry<T> = { at: number; ttl: number; data: T | null };

const memCache = new Map<string, Entry<unknown>>();

function cacheFile(key: string): string {
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 24);
  return join(DISK_CACHE_DIR, `${hash}.json`);
}

async function cacheGet<T>(key: string): Promise<T | null | undefined> {
  const hit = memCache.get(key) as Entry<T> | undefined;
  if (hit) return hit.data;
  try {
    const raw = JSON.parse(await readFile(cacheFile(key), "utf8")) as Entry<T>;
    memCache.set(key, raw);
    return raw.data;
  } catch {
    return undefined; // nothing cached (distinct from a cached null)
  }
}

/** Fresh enough? (age respected separately — some readers accept stale data) */
function entryUsable(e: Entry<unknown> | undefined): boolean {
  return !!e && Date.now() - e.at < e.ttl;
}

async function cacheSet<T>(key: string, data: T | null, ttl: number): Promise<void> {
  const entry: Entry<T> = { at: Date.now(), ttl, data };
  memCache.set(key, entry);
  try {
    await mkdir(DISK_CACHE_DIR, { recursive: true });
    await writeFile(cacheFile(key), JSON.stringify(entry), "utf8");
  } catch {
    /* best-effort */
  }
}

/** Read honoring TTL + stale-while-error for the POSITIVE case only. */
async function cachedJson<T>(key: string, ttl: number, fetcher: () => Promise<T | null>): Promise<T | null> {
  const cached = await cacheGet<Entry<T>>(key).catch(() => undefined);
  const entry = cached as Entry<T> | undefined;
  if (entryUsable(entry)) return entry!.data;
  try {
    const data = await fetcher();
    await cacheSet(key, data, data == null ? NEG_TTL_MS : ttl);
    return data;
  } catch {
    // upstream hiccup — serve stale data rather than nothing
    if (entry && entry.data != null && Date.now() - entry.at < 7 * 24 * 3600 * 1000) return entry.data;
    return null;
  }
}

/* ------------------------------ wire types ------------------------------ */

interface AnivexaEpisodeEntry {
  number?: number;
  title?: string;
  audio?: string;
  id?: string;
}

interface AnivexaProviderEpisodes {
  meta?: { title?: string; matchScore?: number; id?: string } | null;
  episodes?: { sub?: AnivexaEpisodeEntry[]; dub?: AnivexaEpisodeEntry[] } | null;
  error?: unknown;
}

type AnivexaEpisodesResponse = Record<string, AnivexaProviderEpisodes | undefined>;

interface AnivexaWatchStream {
  url?: string;
  type?: string; // "hls" | "mp4" | ...
  audio?: string;
  server?: string;
  referer?: string;
  priority?: number;
  isActive?: boolean;
}

interface AnivexaWatchResponse {
  anilistId?: number;
  episode?: number;
  audio?: string;
  streams?: AnivexaWatchStream[];
  error?: unknown;
}

/* ------------------------------ helpers ------------------------------ */

/** Loose-but-real title match (the Bocchi-for-Edgerunners guard). */
export function titlesRoughlyMatch(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return true; // nothing to compare — don't block on missing titles
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  const tx = new Set(x.split(" "));
  const ty = new Set(y.split(" "));
  let inter = 0;
  for (const t of tx) if (ty.has(t)) inter++;
  const smaller = Math.min(tx.size, ty.size) || 1;
  return inter / smaller >= 0.6; // e.g. "Dandadan" vs "Dan Da Dan" passes, Bocchi vs Cyberpunk fails
}

/** AniList id for a MAL id (AniList is the id Anivexa is keyed on). */
export async function anilistIdForMal(malId: number): Promise<number | null> {
  try {
    const media = await mediaByMal(malId);
    return media?.id ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------ episodes ------------------------------ */

/**
 * Per-provider episode lists for one AniList id (cached 24h, stale-while-
 * error). Providers that error upstream are present with an `error` field —
 * callers must treat them as unavailable.
 */
export async function anivexaEpisodes(
  anilistId: number,
  opts: { fresh?: boolean } = {},
): Promise<AnivexaEpisodesResponse | null> {
  if (opts.fresh) {
    try {
      const data = await fetchAnivexaEpisodes(anilistId);
      await cacheSet(`eps:${anilistId}`, data, EPS_TTL_MS);
      return data;
    } catch {
      return null;
    }
  }
  return cachedJson<AnivexaEpisodesResponse>(`eps:${anilistId}`, EPS_TTL_MS, () =>
    fetchAnivexaEpisodes(anilistId),
  );
}

async function fetchAnivexaEpisodes(anilistId: number): Promise<AnivexaEpisodesResponse | null> {
  const res = await fetch(`${BASE}/episodes/${anilistId}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as AnivexaEpisodesResponse;
  if (!json || typeof json !== "object") return null;
  return json;
}

export interface BackupDubProviderInfo {
  provider: AnivexaProvider;
  name: string;
  /** exact episode numbers the provider declares a dub for (sorted) */
  covered: number[];
  /** highest covered episode (null = none) */
  through: number | null;
  dubCount: number;
  subCount: number;
}

/**
 * Which backup providers carry a dub for this anime (and how far it runs).
 * Applies the wrong-match guard (drops providers whose cached title doesn't
 * match `title`) and ignores providers that error upstream.
 */
export async function anivexaBackupDubSummary(
  malId: number,
  title: string,
): Promise<BackupDubProviderInfo[] | null> {
  const anilistId = await anilistIdForMal(malId);
  if (!anilistId) return null;
  const eps = await anivexaEpisodes(anilistId);
  if (!eps) return null;
  return summarizeProviderDub(eps, title);
}

/** Pure summarizer (exported for tests) — works on a raw episodes payload. */
export function summarizeProviderDub(
  eps: AnivexaEpisodesResponse,
  title: string,
): BackupDubProviderInfo[] {
  const out: BackupDubProviderInfo[] = [];
  for (const provider of ANIVEXA_PROVIDERS) {
    const p = eps[provider];
    if (!p || p.error) continue; // provider down upstream — not offered
    const metaTitle = p.meta?.title?.trim();
    if (metaTitle && !titlesRoughlyMatch(title, metaTitle)) continue; // wrong show — drop
    const dub = (p.episodes?.dub ?? []).filter((e) => Number.isFinite(e.number));
    const sub = (p.episodes?.sub ?? []).filter((e) => Number.isFinite(e.number));
    if (!dub.length) continue; // this provider has no dub for the show at all
    // sparse lists are REAL: reanime lists 467 dubbed One Piece episodes
    // spread across 1168 — a prefix boundary would lie about which episodes
    // are actually dubbed, so we carry the exact covered set instead
    const covered = [...new Set(dub.map((e) => Math.floor(e.number as number)))]
      .filter((n) => n > 0 && n <= 3000)
      .sort((a, b) => a - b);
    if (!covered.length) continue;
    out.push({
      provider,
      name: BACKUP_PROVIDER_NAMES[provider],
      covered,
      through: covered[covered.length - 1],
      dubCount: dub.length,
      subCount: sub.length,
    });
  }
  return out;
}

/* ------------------------------ watch ------------------------------ */

/**
 * Raw stream list for one provider/episode/language. "Episode not found" and
 * friends come back as HTTP 200 + {error} — those are negative-cached so a
 * broken provider doesn't add seconds to every dub play.
 */
export async function anivexaWatch(
  provider: AnivexaProvider,
  anilistId: number,
  lang: "sub" | "dub",
  ep: number,
): Promise<AnivexaWatchStream[] | null> {
  const key = `watch:${provider}:${anilistId}:${lang}:${ep}`;
  return cachedJson<AnivexaWatchStream[]>(key, WATCH_TTL_MS, async () => {
    const res = await fetch(`${BASE}/watch/${provider}/${anilistId}/${lang}/${provider}-${ep}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as AnivexaWatchResponse | null;
    if (!json || json.error) return null;
    const streams = (json.streams ?? []).filter((s) => s && s.url);
    return streams.length ? streams : null;
  });
}

export interface AnivexaResolvedDub {
  src: string;
  referer: string | null;
  provider: AnivexaProvider;
  providerName: string;
  type: "hls" | "mp4";
}

// Streams that FAILED deep validation — remembered 15min per lambda so the
// same ad-wall doesn't burn 10s of probe time on every request (the watch
// cache only stores what the provider DECLARED, not what actually plays).
const rejectedStreams = new Map<string, number>();
const REJECT_MS = 15 * 60 * 1000;

/**
 * Resolve a PLAYABLE English dub for one episode from the backup network.
 *
 * Order: preferred provider first (a server the user explicitly picked),
 * then priority order. A provider only gets tried when its cached dub list
 * actually contains the episode (the per-episode honesty gate). Each stream
 * is playlist-validated live (dead backends skipped); up to `maxAttempts`
 * providers are tried so the dub chain stays inside its latency budget.
 */
export async function anivexaDubStream(
  malId: number,
  ep: number,
  opts: {
    title?: string | null;
    prefer?: AnivexaProvider | null;
    maxAttempts?: number;
    validate?: boolean;
  } = {},
): Promise<AnivexaResolvedDub | null> {
  const { title, prefer, maxAttempts = 2, validate = true } = opts;
  // whole resolve must fit this budget — the /api/stream dub chain runs us
  // AFTER supaplay/megaplay/megaplay-embed, and the player is spinning
  const deadline = Date.now() + 14_000;
  const anilistId = await anilistIdForMal(malId);
  if (!anilistId) return null;
  const eps = await anivexaEpisodes(anilistId);
  if (!eps) return null;

  // candidate providers: declared-dub-for-this-episode only, wrong-match guarded
  const summary = summarizeProviderDub(eps, title ?? "");
  const candidates = summary.filter((s) => s.covered.includes(ep));
  const order: AnivexaProvider[] = [];
  if (prefer && candidates.some((c) => c.provider === prefer)) order.push(prefer);
  for (const p of ANIVEXA_PROVIDERS) {
    if (p !== prefer && candidates.some((c) => c.provider === p)) order.push(p);
  }

  // Fleet verdict gate (DubAudio): a provider whose dub was MEASURED as
  // Japanese audio under the DUB label (or otherwise fake) for this episode
  // never plays — filtered BEFORE maxAttempts so gating doesn't burn
  // attempts. No verdict yet = no opinion (the sweep fills it in over time).
  const gated: AnivexaProvider[] = [];
  for (const provider of order) {
    if ((await getDubAudioVerdict(malId, ep, backupServerId(provider)).catch(() => null)) === "fake") continue;
    gated.push(provider);
  }

  for (const provider of gated.slice(0, maxAttempts)) {
    if (Date.now() > deadline) break; // dub latency budget spent — let the main chain answer
    const streams = await anivexaWatch(provider, anilistId, "dub", ep);
    if (!streams?.length) continue;
    // HLS before progressive, then the provider's own priority (higher wins)
    const ordered = [...streams].sort((a, b) => {
      const ah = /\.m3u8(\?|$)/i.test(a.url ?? "") ? 1 : 0;
      const bh = /\.m3u8(\?|$)/i.test(b.url ?? "") ? 1 : 0;
      if (ah !== bh) return bh - ah;
      return (b.priority ?? 0) - (a.priority ?? 0);
    });
    for (const s of ordered) {
      if (Date.now() > deadline) break;
      const url = s.url!;
      const rejectedAt = rejectedStreams.get(url);
      if (rejectedAt && Date.now() - rejectedAt < REJECT_MS) continue;
      const isHls = /\.m3u8(\?|$)/i.test(url);
      if (validate && isHls) {
        // DEEP check: master + a variant must yield real video bytes — a 200
        // with #EXTM3U alone once let a 143-line ad-image playlist through
        const ok = await hlsLooksPlayable(url, s.referer ?? null);
        if (!ok) {
          rejectedStreams.set(url, Date.now());
          if (rejectedStreams.size > 500) rejectedStreams.clear(); // bounded
          continue;
        }
      } else if (validate) {
        const ok = await urlAlive(url, s.referer ?? null);
        if (!ok) {
          rejectedStreams.set(url, Date.now());
          if (rejectedStreams.size > 500) rejectedStreams.clear();
          continue;
        }
      }
      return {
        src: url,
        referer: s.referer ?? null,
        provider,
        providerName: BACKUP_PROVIDER_NAMES[provider],
        type: isHls ? "hls" : "mp4",
      };
    }
  }
  return null;
}

/* ------------------------------ liveness ------------------------------ */

const UA_HEADERS = (referer: string | null): Record<string, string> =>
  referer
    ? { "User-Agent": UA, Accept: "*/*", Referer: referer }
    : { "User-Agent": UA, Accept: "*/*" };

async function playlistAlive(url: string, referer: string | null): Promise<boolean> {
  try {
    const res = await fetch(url, {
      headers: UA_HEADERS(referer),
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return false;
    const head = await res.text();
    return head.includes("#EXTM3U");
  } catch {
    return false;
  }
}

/**
 * Is a progressive (mp4) source alive? HEAD first, then a ranged GET.
 *
 * The HEAD alone proved fragile in the wild: AnimeGG's /play/.../video.mp4
 * 302-redirects twice (to vidcache.net:8161) and the hop chain regularly
 * needs 4s+ warm — well past half of any sane timeout — and plenty of CDNs
 * flat-out reject HEAD with 403/405 while serving ranged GETs fine. The
 * ranged GET is also the more truthful probe: it is exactly what the player
 * itself will do, and it costs ~1.8 KB.
 */
async function urlAlive(url: string, referer: string | null): Promise<boolean> {
  const head = (method: "HEAD" | "GET"): RequestInit => ({
    method,
    headers: { ...UA_HEADERS(referer), ...(method === "GET" ? { Range: "bytes=0-1880" } : {}) },
    redirect: "follow",
    signal: AbortSignal.timeout(9_000),
  });
  try {
    const res = await fetch(url, head("HEAD"));
    if (res.ok) return true;
  } catch {
    /* fall through to the ranged GET */
  }
  try {
    const res = await fetch(url, head("GET"));
    if (!res.ok && res.status !== 206) return false;
    const buf = await res.arrayBuffer();
    return buf.byteLength > 0;
  } catch {
    return false;
  }
}

/**
 * Does this byte range actually look like VIDEO? (MPEG-TS sync byte 0x47,
 * an fMP4 `ftyp` box, or an ID3 header.) AniNeko's dead storage day and
 * vivibebe's ad-walls (playlists of 143 ad IMAGE "segments") taught us a
 * playlist answering 200 with #EXTM3U can still be garbage — the only test
 * that matters is whether real video bytes come out.
 */
async function bytesLookLikeVideo(url: string, referer: string | null): Promise<boolean> {
  try {
    const res = await fetch(url, {
      headers: { ...UA_HEADERS(referer), Range: "bytes=0-1880" },
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok && res.status !== 206) return false;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length >= 188 && buf[0] === 0x47) return true; // MPEG-TS sync byte
    const head = String.fromCharCode(...buf.slice(0, 640));
    return head.includes("ftyp") || head.startsWith("ID3");
  } catch {
    return false;
  }
}

/** A segment URL that could be real media (ad-farms inject image URLs). */
function plausibleSegment(uri: string, playlistHost: string): boolean {
  try {
    const u = new URL(uri, `https://${playlistHost}`);
    if (/\.(jpg|jpeg|png|gif|webp|svg|html?)(\?|$)/i.test(u.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * DEEP playlist validation — the gate that keeps ad-walls and half-dead
 * providers out of the player:
 *   1. the master answers #EXTM3U
 *   2. one of its variants (highest first) yields a segment that returns
 *      real video bytes (magic-byte probe)
 * Cheap enough for resolve time (one playlist fetch + one ~1.8KB range).
 */
async function hlsLooksPlayable(url: string, referer: string | null): Promise<boolean> {
  let text: string;
  try {
    const res = await fetch(url, {
      headers: UA_HEADERS(referer),
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return false;
    text = await res.text();
    if (!text.includes("#EXTM3U")) return false;
  } catch {
    return false;
  }

  const uris = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  let host = "";
  try { host = new URL(url).hostname; } catch { /* ignore */ }

  // single-variant master = the body IS a media playlist
  let variants = uris.map((u) => new URL(u, url).toString());
  const looksMaster = text.includes("#EXT-X-STREAM-INF");
  if (!looksMaster) {
    // media playlist: probe its own segments directly
    const candidates = uris.filter((u) => plausibleSegment(u, host)).slice(0, 2);
    for (const seg of candidates) {
      if (await bytesLookLikeVideo(new URL(seg, url).toString(), referer)) return true;
    }
    return false;
  }

  // master: probe the variants, highest (last) first — the player will pick
  // that one anyway; one real variant is enough to call it playable
  variants = variants.reverse();
  for (const v of variants.slice(0, 2)) {
    try {
      const vHost = new URL(v).hostname;
      const res = await fetch(v, {
        headers: UA_HEADERS(referer),
        cache: "no-store",
        redirect: "follow",
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) continue;
      const vText = await res.text();
      if (!vText.includes("#EXTM3U")) continue;
      const segs = vText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
        .filter((l) => plausibleSegment(l, vHost))
        .slice(0, 2);
      for (const seg of segs) {
        if (await bytesLookLikeVideo(new URL(seg, v).toString(), referer)) return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

/* ------------------------------ summary cache ------------------------------ */
//
// The episodes grid must never wait on the Anivexa round-trip, so the route
// answers "null" (still probing) from this cache on a miss and warms it in
// the background — the NEXT view of the page shows the backup DUB buttons.

const SUMMARY_TTL_MS = 12 * 3600 * 1000;

function summaryKey(malId: number): string {
  return `summary:${malId}`;
}

/** Cache-only read — null means "not probed yet", never blocks the grid. */
export async function cachedBackupDubSummary(malId: number): Promise<BackupDubProviderInfo[] | null | undefined> {
  return cacheGet<BackupDubProviderInfo[]>(summaryKey(malId));
}

/** Fetch + persist the per-provider dub summary (background warming). */
export async function warmBackupDubSummary(malId: number, title: string): Promise<BackupDubProviderInfo[] | null> {
  const summary = await anivexaBackupDubSummary(malId, title).catch(() => null);
  await cacheSet(summaryKey(malId), summary, SUMMARY_TTL_MS);
  return summary;
}
