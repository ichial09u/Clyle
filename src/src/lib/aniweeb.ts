/**
 * Aniweeb API — the MAL-keyed SUB+DUB backup network (Server #3+).
 *
 * The user's ask: "use Yenime, Aniweeb api, MegaFlix Anime Player, and
 * SupaPlay for both servers for 1 and 2 for dub and sub if zoko and kiwi
 * doesn't have it or isn't working — use these embeddeds to be backups, or
 * if they both don't have a dub episode for an anime already, or sub, it can
 * just fill it in."
 *
 * aniweeb.net fronts FOUR MAL-keyed players per episode and publishes them
 * as clean JSON:
 *
 *   GET https://aniweeb.net/watch/{malId}/servers?ep={ep}&lang={sub|dub}
 *     -> { servers: [{ name, label, type:"iframe", urls:{ sub, dub } }] }
 *        (an empty string = that server carries no dub for this episode —
 *         the per-episode COVERAGE ORACLE for gap-fill)
 *
 * Three of the four are machine-resolvable server-side (the fourth,
 * megaplay.buzz/stream/ani/…, is our existing Megaplay machinery):
 *
 *   api.aniweeb.net  "megaplay · Lu"/"Nagumo" (server=1/2):
 *     GET https://api.aniweeb.net/embed/ani/{malId}/{ep}?track={lang}&server={1|2}&nav=0
 *     -> HTML carrying window.__ANIWEEB_PLAYER =
 *        { hls: "/proxy?u=<urlencoded m3u8>&t=<token>&r=<referer>",
 *          subtitles: [...], ... }
 *     The `u=` param decodes to the real echovideo CDN playlist
 *     (verified: JJK S1E1 DUB, 720p master + real #EXTINF segments).
 *
 *   vidcloud.sbs  "megaplay · Sakamoto":
 *     GET https://vidcloud.sbs/embed-2/v3/e-1/getSources?id={malId}-{ep}-{srv}-{track}
 *     -> { sources: [{ file: "https://vidcloud.sbs/api/proxy/m3u8?t=…",
 *                      type: "hls", label: "Sora"|"Zexy" }], tracks: [vtt] }
 *     Self-proxied HLS (verified: JJK S1E1 DUB, 1080p), no Referer needed,
 *     subtitle VTTs ride along through their own /api/proxy/vtt.
 *
 * Because everything resolves to a REAL playlist, Aniweeb servers play in
 * our own player with cast + download + skip-intro intact — the backups
 * behave exactly like Zoko/Kiwi, for BOTH languages.
 *
 * Server-side only (memory + disk cache like lib/megaplay.ts).
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANIWEEB_ECHO_REFERER, allowHostWithReferer, NO_REFERER } from "@/lib/stream-proxy-registry";
import type { Lang } from "@/lib/zoko";
import type { AniweebServerId } from "@/lib/backup-servers";

const ANIWEEB_BASE = "https://aniweeb.net";
const ANIWEEB_API = "https://api.aniweeb.net";
const VIDCLOUD_BASE = "https://vidcloud.sbs";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const SERVERS_TTL_MS = 24 * 3600 * 1000; // per-episode server lists (coverage oracle)
const COVERAGE_TTL_MS = 12 * 3600 * 1000; // batched per-show coverage map
const STREAM_TTL_MS = 30 * 60 * 1000; // echovideo/vidcloud playlists rotate
const NEG_TTL_MS = 10 * 60 * 1000; // "nothing playable here" — don't re-probe on every request

const DISK_CACHE_DIR =
  process.env.VERCEL === "1" ? join(tmpdir(), "aniweeb") : join(process.cwd(), "db", "aniweeb");

export interface AniweebResolved {
  src: string;
  subtitles: Array<{ lang: string; label: string; default?: boolean; src: string }>;
  referer: string | null;
  resolvedFrom: string;
}

interface AniweebServerEntry {
  name?: string;
  label?: string;
  type?: string;
  urls?: { sub?: string; dub?: string } | null;
}

type CacheEntry<T> = { data: T | null; expires: number };
const streamCache = new Map<string, CacheEntry<AniweebResolved>>();
const serversCache = new Map<string, CacheEntry<AniweebServerEntry[] | null>>();
const coverageCache = new Map<string, CacheEntry<Partial<Record<AniweebServerId, number[]>>>>();

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

/** Register every host an aniweeb stream needs with the proxy registry. */
function registerStreamHosts(stream: AniweebResolved): void {
  try {
    const host = new URL(stream.src).hostname;
    // echovideo CDN -> echo player referer; vidcloud's self-proxy -> none
    allowHostWithReferer(host, /echovideo|aniweeb/i.test(host) ? ANIWEEB_ECHO_REFERER : NO_REFERER);
  } catch {
    /* ignore */
  }
  for (const t of stream.subtitles) {
    try {
      allowHostWithReferer(new URL(t.src).hostname, NO_REFERER);
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------ servers JSON ------------------------------ */

/**
 * Per-episode server list straight from aniweeb.net (cached 24h, memory +
 * disk). This is the COVERAGE ORACLE: `urls.dub` / `urls.sub` empty string
 * = that server carries no such track for this episode.
 */
async function aniweebEpisodeServers(malId: number, ep: number): Promise<AniweebServerEntry[] | null> {
  const key = `servers/${malId}/${ep}`;
  const mem = serversCache.get(key);
  if (mem && mem.expires > Date.now()) return mem.data;
  const disk = (await diskRead<CacheEntry<AniweebServerEntry[] | null>>(key)) as CacheEntry<
    AniweebServerEntry[] | null
  > | null;
  if (disk && disk.expires > Date.now()) {
    serversCache.set(key, disk);
    return disk.data;
  }
  try {
    const res = await fetch(`${ANIWEEB_BASE}/watch/${malId}/servers?ep=${ep}&lang=sub`, {
      headers: { "User-Agent": UA, Accept: "application/json", Referer: `${ANIWEEB_BASE}/` },
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`aniweeb servers -> ${res.status}`);
    const json = (await res.json()) as { servers?: AniweebServerEntry[] };
    const servers = Array.isArray(json?.servers) ? json.servers : null;
    const entry: CacheEntry<AniweebServerEntry[] | null> = {
      data: servers,
      expires: Date.now() + SERVERS_TTL_MS,
    };
    serversCache.set(key, entry);
    void diskWrite(key, entry);
    return servers;
  } catch {
    return null; // network trouble — never cached as "no coverage"
  }
}

/** Does a server entry point at api.aniweeb.net's embed (and which server no)? */
function apiAniweebServerNo(entry: AniweebServerEntry, lang: Lang): 1 | 2 | null {
  const url = entry.urls?.[lang];
  if (!url || !url.includes("api.aniweeb.net")) return null;
  if (/[?&]server=1/.test(url)) return 1;
  if (/[?&]server=2/.test(url)) return 2;
  return null;
}

/* --------------------------- api.aniweeb extractor --------------------------- */

interface AniweebPlayerCfg {
  title?: string;
  hls?: string;
  mp4?: string;
  subtitles?: Array<{ src?: string; label?: string; lang?: string }>;
  servers?: unknown;
}

async function aniweebApiRaw(malId: number, ep: number, lang: Lang, serverNo: 1 | 2): Promise<AniweebResolved | null> {
  const embedUrl = `${ANIWEEB_API}/embed/ani/${malId}/${ep}?track=${lang}&server=${serverNo}&nav=0`;
  const res = await fetch(embedUrl, {
    headers: { "User-Agent": UA, Accept: "text/html", Referer: `${ANIWEEB_BASE}/` },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const html = await res.text();
  const m = html.match(/window\.__ANIWEEB_PLAYER\s*=\s*(\{[\s\S]*?\})\s*<\/script>/) ??
    html.match(/window\.__ANIWEEB_PLAYER\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return null;
  let cfg: AniweebPlayerCfg;
  try {
    cfg = JSON.parse(m[1]) as AniweebPlayerCfg;
  } catch {
    return null;
  }
  // their /proxy path wraps the real playlist: decode u= to the direct m3u8
  let src: string | null = null;
  if (cfg.hls && cfg.hls.includes("u=")) {
    try {
      const u = new URL(cfg.hls, ANIWEEB_API).searchParams.get("u");
      if (u) src = u;
    } catch {
      /* fall through to raw hls */
    }
  }
  if (!src && cfg.hls) src = new URL(cfg.hls, ANIWEEB_API).toString();
  if (!src && cfg.mp4) src = new URL(cfg.mp4, ANIWEEB_API).toString();
  if (!src) return null;
  const subtitles = (cfg.subtitles ?? [])
    .filter((s) => typeof s.src === "string" && s.src)
    .map((s) => ({
      lang: s.lang || "en",
      label: s.label || "English",
      src: new URL(s.src as string, ANIWEEB_API).toString(),
    }));
  const stream: AniweebResolved = { src, subtitles, referer: ANIWEEB_ECHO_REFERER, resolvedFrom: embedUrl };
  registerStreamHosts(stream);
  return stream;
}

/* ----------------------------- vidcloud extractor ----------------------------- */

interface VidcloudSources {
  sources?: Array<{ file?: string; type?: string; label?: string }>;
  tracks?: Array<{ file?: string; label?: string; kind?: string; default?: boolean }>;
}

async function vidcloudRaw(malId: number, ep: number, lang: Lang, serverNo: number): Promise<AniweebResolved | null> {
  const apiUrl = `${VIDCLOUD_BASE}/embed-2/v3/e-1/getSources?id=${malId}-${ep}-${serverNo}-${lang}`;
  const res = await fetch(apiUrl, {
    headers: { "User-Agent": UA, Accept: "application/json", Referer: `${VIDCLOUD_BASE}/` },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const json = (await res.json().catch(() => null)) as VidcloudSources | null;
  const file = json?.sources?.find((s) => typeof s?.file === "string" && s.file)?.file;
  if (!file) return null;
  const subtitles = (json?.tracks ?? [])
    .filter((t) => typeof t?.file === "string" && t.file && (t.kind ?? "captions") !== "thumbnails")
    .map((t) => ({
      lang: "en",
      label: t.label || "English",
      default: t.default === true,
      src: new URL(t.file as string, VIDCLOUD_BASE).toString(),
    }));
  const stream: AniweebResolved = { src: file, subtitles, referer: null, resolvedFrom: apiUrl };
  registerStreamHosts(stream);
  return stream;
}

/* ------------------------------- liveness ------------------------------- */

/**
 * Cheap playlist probe: the master must answer #EXTM3U. Deep segment
 * validation (the anivexa.ts treatment) costs a second fetch + a byte
 * probe per resolve — aniweeb's playlist endpoints are first-party
 * (api.aniweeb.net's own /proxy, vidcloud's own /api/proxy), not ad-wall
 * farms, so the master check + hls.js's own error recovery is enough.
 */
async function playlistLooksReal(url: string, referer: string | null): Promise<boolean> {
  try {
    const headers: Record<string, string> = { "User-Agent": UA, Accept: "*/*" };
    if (referer) headers.Referer = referer;
    const res = await fetch(url, { headers, cache: "no-store", redirect: "follow", signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return false;
    const head = await res.text();
    return head.includes("#EXTM3U");
  } catch {
    return false;
  }
}

/* ------------------------------- public API ------------------------------- */

/**
 * Resolve one episode's playable stream from the Aniweeb network.
 * `which` picks the server (aniweeb-1 = Lu / aniweeb-2 = Nagumo on
 * api.aniweeb.net, vidcloud = the Sakamoto getSources player).
 * Cached 30 min (playlists rotate). Null = nothing playable here.
 */
export async function resolveAniweebStream(
  malId: number,
  ep: number,
  lang: Lang,
  which: AniweebServerId,
  opts: { fresh?: boolean } = {},
): Promise<AniweebResolved | null> {
  const key = `stream/${which}/${lang}/${malId}/${ep}`;
  if (!opts.fresh) {
    const mem = streamCache.get(key);
    if (mem && mem.expires > Date.now()) return mem.data;
    const disk = (await diskRead<CacheEntry<AniweebResolved>>(key)) as CacheEntry<AniweebResolved> | null;
    if (disk && disk.expires > Date.now()) {
      streamCache.set(key, disk);
      if (disk.data) registerStreamHosts(disk.data);
      return disk.data;
    }
  }

  let resolved: AniweebResolved | null = null;
  try {
    if (which === "vidcloud") {
      // server 1 first (the id the site itself uses), server 2 fallback
      resolved = (await vidcloudRaw(malId, ep, lang, 1)) ?? (await vidcloudRaw(malId, ep, lang, 2));
    } else {
      const serverNo = which === "aniweeb-2" ? 2 : 1;
      resolved = await aniweebApiRaw(malId, ep, lang, serverNo);
    }
  } catch {
    resolved = null;
  }
  if (resolved && !resolved.src.startsWith("http")) {
    try {
      resolved.src = new URL(resolved.src, which === "vidcloud" ? VIDCLOUD_BASE : ANIWEEB_API).toString();
    } catch {
      resolved = null;
    }
  }
  if (resolved && !/^https?:\/\//i.test(resolved.src)) resolved = null;
  if (resolved && /\.m3u8(\?|$)/i.test(resolved.src)) {
    const ok = await playlistLooksReal(resolved.src, resolved.referer);
    if (!ok) resolved = null;
  }
  if (!resolved) {
    // negative cache: aniweeb simply doesn't carry this episode/server — a
    // DUB-ONLY title's every sub request used to re-probe all three sources
    const neg: CacheEntry<AniweebResolved> = { data: null, expires: Date.now() + NEG_TTL_MS };
    streamCache.set(key, neg);
    void diskWrite(key, neg);
    return null;
  }

  const entry: CacheEntry<AniweebResolved> = { data: resolved, expires: Date.now() + STREAM_TTL_MS };
  streamCache.set(key, entry);
  void diskWrite(key, entry);
  return resolved;
}

/**
 * Batched per-show coverage: which Aniweeb servers carry WHICH episodes of
 * `eps` (per the servers JSON oracle). Powers the episodes route's
 * backupDub entries — the gap-fill buttons — with one 24h-cached fetch per
 * episode. Server lists that error are skipped (unknown, not "no").
 */
export async function warmAniweebCoverage(
  malId: number,
  eps: number[],
  lang: Lang = "dub",
): Promise<Partial<Record<AniweebServerId, number[]>>> {
  const key = `coverage/${malId}/${lang}`;
  const out: Partial<Record<AniweebServerId, number[]>> = {};
  for (const ep of eps) {
    const servers = await aniweebEpisodeServers(malId, ep);
    if (!servers?.length) continue;
    for (const entry of servers) {
      const url = entry.urls?.[lang];
      if (!url) continue;
      let which: AniweebServerId | null = null;
      if (url.includes("vidcloud.sbs")) which = "vidcloud";
      else {
        const no = apiAniweebServerNo(entry, lang);
        if (no === 1) which = "aniweeb-1";
        else if (no === 2) which = "aniweeb-2";
      }
      // megaplay.buzz entries are our existing Megaplay machinery — skip
      if (!which) continue;
      (out[which] ??= []).push(ep);
    }
  }
  for (const k of Object.keys(out) as AniweebServerId[]) {
    out[k] = [...new Set(out[k]!)].sort((a, b) => a - b);
  }
  const entry: CacheEntry<Partial<Record<AniweebServerId, number[]>>> = {
    data: out,
    expires: Date.now() + COVERAGE_TTL_MS,
  };
  coverageCache.set(key, entry);
  void diskWrite(key, entry);
  return out;
}

/** Cache-only coverage read — undefined = not probed yet / expired (never
 *  blocks; the expired case lets the route's warmer re-probe). A fresh null
 *  stays a definitive "probed, none". */
export async function cachedAniweebCoverage(
  malId: number,
  lang: Lang = "dub",
): Promise<Partial<Record<AniweebServerId, number[]>> | null | undefined> {
  const key = `coverage/${malId}/${lang}`;
  const mem = coverageCache.get(key);
  if (mem) {
    // TTL 12h — without this check a warmed entry was returned forever and
    // Aniweeb's growing dub coverage never refreshed
    if (mem.expires > Date.now()) return mem.data;
    coverageCache.delete(key);
  }
  const disk = (await diskRead<CacheEntry<Partial<Record<AniweebServerId, number[]>>>>(key)) as CacheEntry<
    Partial<Record<AniweebServerId, number[]>>
  > | null;
  if (disk && disk.expires > Date.now()) {
    coverageCache.set(key, disk);
    return disk.data;
  }
  return undefined;
}
