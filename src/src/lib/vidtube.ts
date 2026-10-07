/**
 * VidTube DUB resolver — the "anikoto-vidplay" backfill source.
 *
 * The megaplay EMBED network (see anikoto.ts) serves ad-stub fake dubs for
 * some shows (Cyberpunk: Edgerunners: every megaplay/flikhub answer is a
 * 313-line tiktokcdn ad playlist) — but AniKoto's OWN server list carries a
 * VidPlay server whose VidTube file pages stream the REAL dub:
 *
 *   1. episodes: GET https://anikototv.to/ajax/episode/list/{seriesId}?ep=1
 *                (X-Requested-With: XMLHttpRequest, referer /watch/{slug})
 *                -> result HTML: <a data-id="{epId}" data-ids="{blob}"> per
 *                episode, in order. The blob encodes the server-list key.
 *   2. servers:  GET https://anikototv.to/ajax/server/list?servers={blob}
 *                -> result HTML: <li data-link-id="{linkId}"> per server
 *                (Vidstream-2 / HD-1 sub+dub, VidPlay-1 dub).
 *   3. link:     GET https://anikototv.to/ajax/server?get={linkId}
 *                -> { result: { url, skip_data } }; the VidPlay entries
 *                answer https://vidtube.site/stream/{key}/dub.
 *   4. file id:  GET {vidtube url} -> <div data-id="{fileId}">
 *   5. stream:   GET https://vidtube.site/stream/getSourcesNew?id={fileId}&type=dub
 *                (X-Requested-With: XMLHttpRequest — the legacy getSources
 *                ALSO wants it; without it both answer 403 "AJAX only")
 *                -> { sources:{ file: master.m3u8 }, tracks:[…], intro, outro }
 *
 * Host notes:
 *   - vidtube master variants live on s1.akirax.buzz; media segments on
 *     s3.shiora.top — both want `Referer: https://vidtube.site/`.
 *   - The real episodes' media segments are DISGUISED as `NNNN.jpg` files
 *     (MPEG-TS bytes; the fleet's ASR check confirmed real English dialogue),
 *     so the fake-dub detector here counts segments by duration + ad-host,
 *     not by the `seg-N-` name the megaplay CDNs use.
 *   - The first (1080p) variant can 404 behind a Backblaze error; hls.js
 *     drops the broken level and lands on 720p — no client change needed.
 *
 * Fake-dub guard: undubbed episodes still answer a playlist — the ad-stub
 * stubs are 100% tiktokcdn image lines. Real = no tiktokcdn lines AND
 * summed EXTINF duration >= 300s (a real episode).
 *
 * Mapping lives in Anime.anikotoSeriesId (same mapping anikoto.ts uses).
 * DUB ONLY: sub always flows through Zoko/Kiwi untouched. Server-only;
 * curl-first transport (anikototv 403s undici's TLS fingerprint).
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@/lib/db";
import { allowHostWithReferer } from "@/lib/stream-proxy-registry";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ANIKOTO = "https://anikototv.to";
const VIDTUBE_GET_SOURCES = "https://vidtube.site/stream/getSourcesNew";
const VIDTUBE_REFERER = "https://vidtube.site/";
const STREAM_TTL_MS = 30 * 60 * 1000; // token URLs rotate — same as Zoko/megaplay
const LINKS_TTL_MS = 6 * 3600 * 1000; // anikoto episode blobs are stable hourly
const DUB_CHECK_TTL_MS = 24 * 3600 * 1000;

const DISK_CACHE_DIR =
  process.env.VERCEL === "1" ? join(tmpdir(), "vidtube") : join(process.cwd(), "db", "vidtube");

export interface VidtubeStream {
  src: string;
  subtitles: Array<{ lang: string; label: string; src: string }>;
  resolvedFrom: string;
  filePage: string;
}

type CacheEntry = { data: VidtubeStream | null; expires: number };
type LinksEntry = { data: Map<number, string>; expires: number };
type VerdictEntry = { data: boolean; expires: number };
const cache = new Map<string, CacheEntry>();
const linksCache = new Map<string, LinksEntry>();
const verdicts = new Map<string, VerdictEntry>();
const inFlight = new Map<string, Promise<VidtubeStream | null>>();

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

/* ---- transport: curl first (anikototv 403s undici), fetch as fallback --- */

function curlGet(
  url: string,
  referer: string,
  timeoutMs: number,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const args: string[] = [
      "-sS", "--max-time", String(Math.ceil(timeoutMs / 1000)),
      "-A", UA,
      "-H", `Referer: ${referer}`,
      "-H", "Accept-Language: en-US,en;q=0.9",
      "-H", "X-Requested-With: XMLHttpRequest", // anikoto/vidtube AJAX gate
      "-w", "\n__STATUS__%{http_code}",
    ];
    for (const [k, v] of Object.entries(extraHeaders)) args.push("-H", `${k}: ${v}`);
    args.push(url);
    execFile(
      "curl",
      args,
      { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs + 5_000 },
      (err, stdout, stderr) => {
        const m = stdout.match(/__STATUS__(\d+)\s*$/);
        if (!m) return reject(new Error(stderr || err?.message || "curl failed"));
        resolve({ status: parseInt(m[1], 10), body: stdout.replace(/__STATUS__\d+\s*$/, "") });
      },
    );
  });
}

async function get(
  url: string,
  referer: string,
  timeoutMs: number,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  try {
    return await curlGet(url, referer, timeoutMs, extraHeaders);
  } catch {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: referer, "Accept-Language": "en-US,en;q=0.9", "X-Requested-With": "XMLHttpRequest", ...extraHeaders },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, body: await res.text() };
  }
}

/* ---- host registration -------------------------------------------------- */

function registerStreamHosts(stream: VidtubeStream): void {
  for (const url of [stream.src, ...stream.subtitles.map((s) => s.src)]) {
    try {
      allowHostWithReferer(new URL(url).hostname, VIDTUBE_REFERER);
    } catch {
      /* ignore */
    }
  }
}

/* ---- anikoto episode blobs --------------------------------------------- */

/**
 * Per-episode anikoto `data-ids` blobs (the server-list key) for a series.
 * The episode/list endpoint answers the WHOLE list at once — parse each
 * data-id/data-ids pair in DOM order and zip with the episode numbers.
 * Cached 6h (memory + disk).
 */
async function anikotoEpBlobs(seriesId: number): Promise<Map<number, string>> {
  const key = `links/${seriesId}`;
  if (!linksCache.has(key) || (linksCache.get(key)!.expires ?? 0) < Date.now()) {
    const disk = (await diskRead<LinksEntry>(key)) as LinksEntry | null;
    if (disk && disk.expires > Date.now()) {
      linksCache.set(key, { data: new Map(disk.data), expires: disk.expires });
    }
  }
  const mem = linksCache.get(key);
  if (mem && mem.expires > Date.now()) return mem.data;

  const list = await get(`${ANIKOTO}/ajax/episode/list/${seriesId}?ep=1`, `${ANIKOTO}/`, 20_000);
  if (list.status !== 200) throw new Error(`episode/list ${list.status}`);
  let result: string;
  try {
    result = (JSON.parse(list.body) as { result?: string }).result ?? "";
  } catch {
    throw new Error("episode/list invalid json");
  }
  const pairs = [...result.matchAll(/data-ids="([^"]+)"/g)].map((m) => m[1]);
  if (!pairs.length) throw new Error("episode/list no data-ids");
  const map = new Map<number, string>();
  pairs.forEach((blob, i) => map.set(i + 1, blob)); // DOM order == episode order
  const entry: LinksEntry = { data: map, expires: Date.now() + LINKS_TTL_MS };
  linksCache.set(key, entry);
  void diskWrite(key, { data: [...map.entries()], expires: entry.expires } as unknown);
  return map;
}

/** Resolve anikoto's VidTube file page for one episode (per-ep, per-series). */
async function vidtubeFilePage(seriesId: number, ep: number): Promise<string | null> {
  const blobs = await anikotoEpBlobs(seriesId);
  const blob = blobs.get(ep);
  if (!blob) return null; // no such episode on anikoto

  const servers = await get(
    `${ANIKOTO}/ajax/server/list?servers=${encodeURIComponent(blob)}`,
    `${ANIKOTO}/`,
    20_000,
  );
  if (servers.status !== 200) throw new Error(`server/list ${servers.status}`);
  let result: string;
  try {
    result = (JSON.parse(servers.body) as { result?: string }).result ?? "";
  } catch {
    throw new Error("server/list invalid json");
  }
  const linkIds = [...result.matchAll(/data-link-id="([^"]+)"/g)].map((m) => m[1]);
  if (!linkIds.length) return null; // no servers for this episode

  // resolve each server link; the VidPlay entries answer a vidtube.site
  // file page ending in /dub. The megaplay embed entries (s-2/{id}/dub)
  // belong to anikoto.ts's chain — skip them here.
  for (const linkId of linkIds) {
    try {
      const res = await get(`${ANIKOTO}/ajax/server?get=${encodeURIComponent(linkId)}`, `${ANIKOTO}/`, 20_000);
      if (res.status !== 200) continue;
      const json = JSON.parse(res.body) as { result?: { url?: string } | null };
      const url = json?.result?.url;
      if (url && /^https:\/\/(www\.)?vidtube\.site\//.test(url) && /\/dub/.test(url)) return url;
    } catch {
      /* try the next server */
    }
  }
  return null; // no vidtube dub server on this episode
}

/* ---- vidtube getSources -------------------------------------------------- */

async function resolveVidtubeDubRaw(malId: number, ep: number): Promise<VidtubeStream | null> {
  const anime = await db.anime.findUnique({
    where: { malId },
    select: { anikotoSeriesId: true },
  });
  const seriesId = anime?.anikotoSeriesId;
  if (!seriesId) return null; // unmapped — caller falls through

  const filePage = await vidtubeFilePage(seriesId, ep);
  if (!filePage) return null; // no vidtube dub server for this episode

  const page = await get(filePage, VIDTUBE_REFERER, 20_000);
  if (page.status !== 200) throw new Error(`vidtube page ${page.status}`);
  const m = page.body.match(/data-id="(\d+)"/);
  if (!m) return null; // file page without a playable id

  const res = await get(`${VIDTUBE_GET_SOURCES}?id=${m[1]}&type=dub`, VIDTUBE_REFERER, 20_000);
  if (res.status !== 200) throw new Error(`vidtube getSources ${res.status}`);
  const json = JSON.parse(res.body) as {
    sources?: { file?: string } | null;
    tracks?: Array<{ file?: string; label?: string; kind?: string; default?: boolean }>;
  };
  const file = json?.sources?.file;
  if (!file) return null; // definitive: no dub stream for this episode
  const stream: VidtubeStream = {
    src: file,
    subtitles: (json.tracks ?? [])
      .filter((t) => (t.kind ?? "captions") !== "thumbnails" && t.file)
      .map((t) => ({
        lang: "en",
        label: t.label || "English",
        default: t.default === true,
        src: t.file as string,
      })),
    resolvedFrom: `${VIDTUBE_GET_SOURCES}?id=${m[1]}&type=dub`,
    filePage,
  };
  registerStreamHosts(stream);
  return stream;
}

/**
 * Resolve the VidTube DUB stream (HLS) for one episode. Requires
 * Anime.anikotoSeriesId; null otherwise or when the episode lacks a
 * VidPlay dub server. Cached 30 min (memory + disk), stale-while-error.
 */
export async function vidtubeDub(
  malId: number,
  ep: number,
  opts: { fresh?: boolean } = {},
): Promise<VidtubeStream | null> {
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
      const data = await resolveVidtubeDubRaw(malId, ep);
      const entry: CacheEntry = { data, expires: Date.now() + STREAM_TTL_MS };
      cache.set(key, entry);
      void diskWrite(key, entry);
      return data;
    } catch (err) {
      // transient (timeout / 5xx): serve stale if we have it, never a fake "no dub"
      const stale = cache.get(key) ?? (await diskRead<CacheEntry>(key));
      if (stale) return stale.data;
      console.error("[vidtube]", err instanceof Error ? err.message : err);
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, job);
  return job;
}

/* ---- fake-dub verification (ad-stub detector) --------------------------- */

function dubCheckKey(malId: number, ep: number): string {
  return `vidtubecheck/${malId}/${ep}`;
}

async function cacheVerdict(key: string, verdict: boolean): Promise<void> {
  const entry: VerdictEntry = { data: verdict, expires: Date.now() + DUB_CHECK_TTL_MS };
  verdicts.set(key, entry);
  await diskWrite(key, entry);
}

/**
 * VidTube segment shapes: real episodes carry ~8s `.jpg`-named MPEG-TS
 * segments (disguised) or `seg-N-…` files; ad-stub stubs are 100%
 * tiktokcdn image lines. Real = no tiktokcdn AND >= 300s summed duration
 * (a real episode runs 20+ minutes; the guard tolerates a truncated tail).
 */
async function realSegmentCheck(masterUrl: string): Promise<boolean | null> {
  const headers = { "User-Agent": UA, Referer: VIDTUBE_REFERER, Accept: "*/*" };
  let master: string;
  try {
    const mres = await fetch(masterUrl, { headers, cache: "no-store", signal: AbortSignal.timeout(12_000) });
    if (!mres.ok) return null;
    master = await mres.text();
  } catch {
    return null;
  }
  // try variants in order until one answers (the 1080p variant can 404)
  const variants = master
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  for (const variant of variants) {
    const vurl = new URL(variant, masterUrl).href;
    let vtext: string;
    try {
      const vres = await fetch(vurl, { headers, cache: "no-store", signal: AbortSignal.timeout(12_000) });
      if (!vres.ok) continue;
      vtext = await vres.text();
    } catch {
      continue;
    }
    const lines = vtext.split("\n").map((l) => l.trim()).filter(Boolean);
    const segs = lines.filter((l) => !l.startsWith("#"));
    const ads = segs.filter((l) => /tiktokcdn\.com/.test(l)).length;
    if (ads > 0 && ads >= segs.length) return false; // pure ad-stub playlist
    const durations = lines
      .map((l) => (l.match(/#EXTINF:([0-9.]+)/) || [])[1])
      .filter(Boolean)
      .map(Number);
    const total = durations.reduce((a, b) => a + b, 0);
    const realSegs = segs.filter((l) => /seg-\d+-|\.jpg(\?|$)|\.ts(\?|$)/.test(l) && !/tiktokcdn\.com/.test(l)).length;
    if (realSegs >= 3 && total >= 300) return true; // a real episode
    if (segs.length > 0 && total > 0) return false; // real answer, not an episode
  }
  return null; // every variant unreachable — no verdict
}

/**
 * Does a REAL English dub exist for this episode on VidTube (AniKoto's
 * VidPlay server)? true / false (definitive: no server, no file page, or
 * ad-stub playlist) / null (transient — never cached, never blocking).
 */
export async function verifyRealVidtubeDub(malId: number, ep: number): Promise<boolean | null> {
  const key = dubCheckKey(malId, ep);
  const mem = verdicts.get(key);
  if (mem && mem.expires > Date.now()) return mem.data;
  const disk = (await diskRead<VerdictEntry>(key)) as VerdictEntry | null;
  if (disk && disk.expires > Date.now() && typeof disk.data === "boolean") {
    verdicts.set(key, disk);
    return disk.data;
  }

  try {
    const stream = await vidtubeDub(malId, ep);
    if (!stream) {
      await cacheVerdict(key, false); // resolved cleanly: no vidtube dub
      return false;
    }
    const check = await realSegmentCheck(stream.src);
    if (check == null) return null; // network trouble — no verdict
    await cacheVerdict(key, check);
    return check;
  } catch {
    return null;
  }
}
