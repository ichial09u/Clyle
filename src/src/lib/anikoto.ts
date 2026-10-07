/**
 * AniKoto DUB resolver — the "megaplay-embed" backfill source.
 *
 * Flikhub's malId-keyed megaplay API misses shows the megaplay EMBED network
 * actually carries (Jujutsu Kaisen 2nd Season: flikhub answers an ad-stub,
 * the embed network streams the real dub). The embed ids come from AniKoto:
 *
 *   1. search:  GET https://anikototv.to/filter?keyword={title}
 *               -> .ani.poster[data-tip="{seriesId}"] + /watch/{slug}/ep-N
 *   2. episodes: GET https://anikotoapi.site/series/{seriesId}
 *               -> data.episodes[].episode_embed_id (per episode, per series)
 *   3. stream:  GET https://megaplay.buzz/stream/getSources?id={embedId}&type=dub
 *               -> { sources:{ file: master.m3u8 }, tracks:[…], intro, outro }
 *
 * The m3u8 hosts (cdn.kryntal.top / megap.norami.top / megap.akirax.buzz /
 * megap.shiora.site …) want `Referer: https://megaplay.buzz/` — the same
 * hosts the flikhub resolver registers, /api/stream/proxy already injects it.
 *
 * Fake-dub guard: like flikhub, undubbed episodes still return a playlist —
 * count REAL `seg-N-` media segments (>=3) and reject ad-stub playlists.
 *
 * The mapping lives in the catalog: Anime.anikotoSeriesId (discovered by the
 * dub-hunt campaign via title search). Unmapped anime yield null — the chain
 * falls through. DUB ONLY: sub always flows through Zoko/Kiwi untouched.
 *
 * Server-only. Mirrors supaplay.ts/megaplay.ts cache shapes (memory + disk,
 * stale-while-error). anikototv.to/anikotoapi.site 403 undici's TLS
 * fingerprint → curl-first transport (same as supaplay.ts).
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@/lib/db";
import { allowHostWithReferer, MEGAPLAY_REFERER } from "@/lib/stream-proxy-registry";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const FILTER_URL = "https://anikototv.to/filter";
const ANIKOTO_API = "https://anikotoapi.site/series";
const GET_SOURCES = "https://megaplay.buzz/stream/getSources";
const STREAM_TTL_MS = 30 * 60 * 1000; // token URLs rotate — same as Zoko/megaplay
const EPS_TTL_MS = 6 * 3600 * 1000; // anikoto episode lists are stable hourly
const DUB_CHECK_TTL_MS = 24 * 3600 * 1000;

const DISK_CACHE_DIR =
  process.env.VERCEL === "1" ? join(tmpdir(), "anikoto") : join(process.cwd(), "db", "anikoto");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AnikotoStream {
  src: string;
  subtitles: Array<{ lang: string; label: string; default?: boolean; src: string }>;
  resolvedFrom: string;
  embedId: number;
}

type CacheEntry = { data: AnikotoStream | null; expires: number };
type EpsEntry = { data: Array<{ number: number; embedId: number | null }>; expires: number };
type VerdictEntry = { data: boolean; expires: number };
const cache = new Map<string, CacheEntry>();
const epsCache = new Map<string, EpsEntry>();
const verdicts = new Map<string, VerdictEntry>();
const inFlight = new Map<string, Promise<AnikotoStream | null>>();

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

/* ---- transport: curl first (Cloudflare 403s undici), fetch as fallback -- */

function curlGet(url: string, referer: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "curl",
      [
        "-sS", "--max-time", String(Math.ceil(timeoutMs / 1000)),
        "-A", UA,
        "-H", `Referer: ${referer}`,
        "-H", "Accept-Language: en-US,en;q=0.9",
        "-w", "\n__STATUS__%{http_code}",
        url,
      ],
      { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs + 5_000 },
      (err, stdout, stderr) => {
        const m = stdout.match(/__STATUS__(\d+)\s*$/);
        if (!m) return reject(new Error(stderr || err?.message || "curl failed"));
        resolve({ status: parseInt(m[1], 10), body: stdout.replace(/__STATUS__\d+\s*$/, "") });
      },
    );
  });
}

async function get(url: string, referer: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  try {
    return await curlGet(url, referer, timeoutMs);
  } catch {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: referer, "Accept-Language": "en-US,en;q=0.9" },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, body: await res.text() };
  }
}

/* ---- catalog search: title -> series id -------------------------------- */

export function normalizeTitle(t: string): string {
  return String(t || "")
    .toLowerCase()
    // accent-fold BEFORE stripping: "Pokémon" must collapse to "pokemon" so
    // it can match its own ASCII slug (NFD splits é into e + combining mark)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface AnikotoHit {
  id: number;
  slug: string;
}

/** Search AniKoto's filter page for a title; returns candidate series. */
export async function anikotoSearchSeries(title: string): Promise<AnikotoHit[]> {
  const q = normalizeTitle(title).replace(/ /g, "+");
  if (!q) return [];
  const res = await get(`${FILTER_URL}?keyword=${q}`, "https://anikototv.to/", 20_000);
  if (res.status !== 200) return [];
  const hits: AnikotoHit[] = [];
  const seen = new Set<number>();
  const re = /data-tip="(\d+)"[^>]*>\s*<a href="[^"]*\/watch\/([a-zA-Z0-9-]+?)\/ep-\d+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(res.body))) {
    const id = parseInt(m[1], 10);
    if (Number.isFinite(id) && id > 0 && !seen.has(id)) {
      seen.add(id);
      hits.push({ id, slug: m[2] });
    }
  }
  return hits;
}

/** Slug without the trailing random token: "jujutsu-kaisen-2nd-season-hk2c9" -> "jujutsu kaisen 2nd season". */
export function slugToTitle(slug: string): string {
  return normalizeTitle(String(slug || "").replace(/-[a-z0-9]{5}$/i, ""));
}

/** Pick the AniKoto series whose slug best matches one of the titles. */
export function pickSeriesHit(hits: AnikotoHit[], titles: string[], totalEpisodes?: number): AnikotoHit | null {
  const wants = titles.map(normalizeTitle).filter(Boolean);
  if (!wants.length) return null;
  let best: { hit: AnikotoHit; score: number } | null = null;
  for (const hit of hits) {
    const slugTitle = slugToTitle(hit.slug);
    for (const want of wants) {
      if (!slugTitle || !want) continue;
      let score = 0;
      if (slugTitle === want) score = 100;
      else if (slugTitle.startsWith(want) || want.startsWith(slugTitle)) {
        // prefix match: the closer the lengths, the better (avoids "one piece"
        // matching "one piece film: strong world")
        const ratio = Math.min(want.length, slugTitle.length) / Math.max(want.length, slugTitle.length);
        score = 60 + Math.round(ratio * 35);
      }
      if (score > 0 && (!best || score > best.score)) best = { hit, score };
    }
  }
  return best?.hit ?? null;
}

/** Fetch (cached) the AniKoto episode list for one series id. */
export async function anikotoEpisodeEmbedIds(seriesId: number): Promise<Array<{ number: number; embedId: number | null }>> {
  const key = `eps/${seriesId}`;
  const mem = epsCache.get(key);
  if (mem && mem.expires > Date.now()) return mem.data;
  const disk = (await diskRead<EpsEntry>(key)) as EpsEntry | null;
  if (disk && disk.expires > Date.now() && Array.isArray(disk.data)) {
    epsCache.set(key, disk);
    return disk.data;
  }
  const res = await get(`${ANIKOTO_API}/${seriesId}`, "https://anikototv.to/", 20_000);
  if (res.status !== 200) throw new Error(`anikotoapi ${res.status}`);
  const json = JSON.parse(res.body) as {
    ok?: boolean;
    data?: { episodes?: Array<{ number?: number; episode?: number; episode_embed_id?: string | number | null }> };
  };
  if (!json || json.ok !== true || !json.data) throw new Error("anikotoapi invalid");
  const eps = (json.data.episodes ?? [])
    .map((e) => ({
      number: Number(e.number ?? e.episode ?? 0),
      embedId: e.episode_embed_id != null ? Number(e.episode_embed_id) || null : null,
    }))
    .filter((e) => e.number > 0);
  const entry: EpsEntry = { data: eps, expires: Date.now() + EPS_TTL_MS };
  epsCache.set(key, entry);
  void diskWrite(key, entry);
  return eps;
}

/* ---- stream resolution -------------------------------------------------- */

function registerStreamHosts(stream: AnikotoStream): void {
  for (const url of [stream.src, ...stream.subtitles.map((s) => s.src)]) {
    try {
      allowHostWithReferer(new URL(url).hostname, MEGAPLAY_REFERER);
    } catch {
      /* ignore */
    }
  }
}

async function resolveAnikotoDubRaw(malId: number, ep: number): Promise<AnikotoStream | null> {
  const anime = await db.anime.findUnique({
    where: { malId },
    select: { anikotoSeriesId: true },
  });
  const seriesId = anime?.anikotoSeriesId;
  if (!seriesId) return null; // unmapped — caller falls through

  const eps = await anikotoEpisodeEmbedIds(seriesId);
  const embedId = eps.find((e) => e.number === ep)?.embedId ?? null;
  if (!embedId) return null; // no embed for this episode number

  const res = await get(`${GET_SOURCES}?id=${embedId}&type=dub`, "https://megaplay.buzz/", 20_000);
  if (res.status !== 200) throw new Error(`getSources ${res.status}`);
  const json = JSON.parse(res.body) as {
    sources?: { file?: string } | null;
    tracks?: Array<{ file?: string; label?: string; kind?: string; default?: boolean }>;
  };
  const file = json?.sources?.file;
  if (!file) return null; // definitive: no dub stream for this episode
  const stream: AnikotoStream = {
    src: file,
    subtitles: (json.tracks ?? [])
      .filter((t) => (t.kind ?? "captions") !== "thumbnails" && t.file)
      .map((t) => ({
        lang: "en",
        label: t.label || "English",
        default: t.default === true,
        src: t.file as string,
      })),
    resolvedFrom: `${GET_SOURCES}?id=${embedId}&type=dub`,
    embedId,
  };
  registerStreamHosts(stream);
  return stream;
}

/**
 * Resolve the megaplay-embed DUB stream (HLS) for one episode. Requires
 * Anime.anikotoSeriesId; null otherwise or when the episode lacks dub.
 * Cached 30 min (memory + disk), stale-while-error.
 */
export async function anikotoDub(
  malId: number,
  ep: number,
  opts: { fresh?: boolean } = {},
): Promise<AnikotoStream | null> {
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
      const data = await resolveAnikotoDubRaw(malId, ep);
      const entry: CacheEntry = { data, expires: Date.now() + STREAM_TTL_MS };
      cache.set(key, entry);
      void diskWrite(key, entry);
      return data;
    } catch (err) {
      const stale = cache.get(key) ?? (await diskRead<CacheEntry>(key));
      if (stale) return stale.data;
      console.error("[anikoto]", err instanceof Error ? err.message : err);
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, job);
  return job;
}

/* ---- fake-dub verification (real-segment detector) ---------------------- */

function dubCheckKey(malId: number, ep: number): string {
  return `dubcheck/${malId}/${ep}`;
}

async function cacheVerdict(key: string, verdict: boolean): Promise<void> {
  const entry: VerdictEntry = { data: verdict, expires: Date.now() + DUB_CHECK_TTL_MS };
  verdicts.set(key, entry);
  await diskWrite(key, entry);
}

async function realSegmentCount(masterUrl: string): Promise<number | null> {
  const headers = { "User-Agent": UA, Referer: MEGAPLAY_REFERER, Accept: "*/*" };
  let master: string;
  try {
    const mres = await fetch(masterUrl, { headers, cache: "no-store", signal: AbortSignal.timeout(12_000) });
    if (!mres.ok) return null;
    master = await mres.text();
  } catch {
    return null;
  }
  const variant = master.split("\n").find((l) => l.trim() && !l.startsWith("#"));
  if (!variant) return 0;
  const vurl = new URL(variant.trim(), masterUrl).href;
  let vtext: string;
  try {
    const vres = await fetch(vurl, { headers, cache: "no-store", signal: AbortSignal.timeout(12_000) });
    if (!vres.ok) return null;
    vtext = await vres.text();
  } catch {
    return null;
  }
  return vtext
    .split("\n")
    .filter((l) => {
      const s = l.trim();
      return s && !s.startsWith("#") && /seg-\d+-/.test(s) && !/tiktokcdn\.com/.test(s);
    }).length;
}

/** One getSources attempt: "file" | "nofile" | "error" */
type SourcesAttempt = "file" | "nofile" | "error";

async function getSourcesAttempt(embedId: number): Promise<{ attempt: SourcesAttempt; file?: string }> {
  try {
    const res = await get(`${GET_SOURCES}?id=${embedId}&type=dub`, "https://megaplay.buzz/", 20_000);
    if (res.status !== 200) return { attempt: "error" };
    const json = JSON.parse(res.body) as { sources?: { file?: string } | null };
    const file = json?.sources?.file;
    return file ? { attempt: "file", file } : { attempt: "nofile" };
  } catch {
    return { attempt: "error" };
  }
}

/**
 * Does a REAL English dub exist for this episode on the megaplay-embed
 * network? true / false (definitive: no embed, or no file on TWO agreeing
 * attempts / ad-stub playlist) / null (transient — never cached, never
 * blocking). getSources intermittently answers empty for a beat, so a
 * single "no file" is NOT proof — the boundary search must not walk back
 * on that (observed live on JJK S2 ep23).
 */
export async function verifyRealAnikotoDub(malId: number, ep: number): Promise<boolean | null> {
  const key = dubCheckKey(malId, ep);
  const mem = verdicts.get(key);
  if (mem && mem.expires > Date.now()) return mem.data;
  const disk = (await diskRead<VerdictEntry>(key)) as VerdictEntry | null;
  if (disk && disk.expires > Date.now() && typeof disk.data === "boolean") {
    verdicts.set(key, disk);
    return disk.data;
  }

  try {
    const anime = await db.anime.findUnique({ where: { malId }, select: { anikotoSeriesId: true } });
    const seriesId = anime?.anikotoSeriesId;
    if (!seriesId) return null; // unmapped: this source can't say anything

    let eps: Array<{ number: number; embedId: number | null }>;
    try {
      eps = await anikotoEpisodeEmbedIds(seriesId);
    } catch {
      return null; // transient (anikotoapi hiccup) — no verdict
    }
    const embedId = eps.find((e) => e.number === ep)?.embedId ?? null;
    if (!embedId) {
      await cacheVerdict(key, false); // episode has no embed id at all
      return false;
    }

    const first = await getSourcesAttempt(embedId);
    if (first.attempt === "file" && first.file) {
      const count = await realSegmentCount(first.file);
      if (count == null) return null; // m3u8 fetch trouble — no verdict
      const real = count >= 3; // a real episode has hundreds; stubs have 0
      await cacheVerdict(key, real);
      return real;
    }
    if (first.attempt === "error") return null; // transient — never cached

    // first attempt said "no file" — confirm once before believing it
    await sleep(1_500);
    const second = await getSourcesAttempt(embedId);
    if (second.attempt === "file" && second.file) {
      const count = await realSegmentCount(second.file);
      if (count == null) return null;
      const real = count >= 3;
      await cacheVerdict(key, real);
      return real;
    }
    if (second.attempt === "error") return null; // mixed signals — no verdict
    await cacheVerdict(key, false); // two clean "no file" answers
    return false;
  } catch {
    return null;
  }
}
