/**
 * SupaPlay DUB resolver (Server #1's DUB backfill source).
 *
 * SupaPlay's classic/Ani embed endpoints are dead ("Content Removed"), but
 * the MW ArtPlayer endpoint is alive:
 *   iframe https://supaplay.fun/mw/{detailPath}/{season}/{episode}
 *
 * The iframe's own JS does two calls we can do server-side:
 *   1. subjectId: GET https://h5-api.aoneroom.com/wefeed-h5api-bff/detail?detailPath={path}
 *      -> data.subject.subjectId
 *   2. streams:   GET https://hacker.moviewatchtv.fun/fetchVideo
 *                    ?subjectId={id}&se={season}&ep={episode}&detailPath={path}&proxy=1
 *      (requires a browser UA + `Referer: https://supaplay.fun/`, else
 *       Cloudflare answers "Just a moment...")
 *      -> data.streams[] = [{ url, resolution, resolutionValue, format:"MP4", … }]
 *
 * The catch: detailPath is a MovieBox-style slug with an unguessable random
 * suffix ("jujutsu-kaisen-english-KD0jSM9ot5") and NEITHER supaplay nor the
 * aoneroom H5 API exposes a search endpoint. So the mapping lives in the
 * catalog: `Anime.supaplayPath` (seeded where known). Animes without a
 * mapping simply yield to the Megaplay/yenime fallback.
 *
 * DUB ONLY — the streams behind "-english" detailPaths are the English dubs;
 * SUB keeps flowing through Zoko/Kiwi untouched.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@/lib/db";
import { allowHostWithReferer, NO_REFERER } from "@/lib/stream-proxy-registry";

const AONEROOM_DETAIL = "https://h5-api.aoneroom.com/wefeed-h5api-bff/detail";
const FETCH_VIDEO = "https://hacker.moviewatchtv.fun/fetchVideo";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SUPAPLAY_REFERER = "https://supaplay.fun/";
const TTL_MS = 30 * 60 * 1000; // MP4 sign URLs carry their own expiry
const SUBJECT_TTL_MS = 7 * 24 * 3600 * 1000; // subjectIds are stable

const DISK_CACHE_DIR =
  process.env.VERCEL === "1" ? join(tmpdir(), "supaplay") : join(process.cwd(), "db", "supaplay");

export interface SupaplayStream {
  src: string;
  subtitles: Array<{ lang: string; label: string; default?: boolean; src: string }>;
  resolvedFrom: string;
  resolution: string;
}

type CacheEntry = { data: SupaplayStream | null; expires: number };
type SubjectEntry = { data: string; expires: number };
const cache = new Map<string, CacheEntry>();
const subjectCache = new Map<string, SubjectEntry>();

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

/** Map a detailPath to its stable subjectId (cached 7 days). */
async function subjectIdFor(detailPath: string): Promise<string | null> {
  const key = `subject/${detailPath}`;
  const mem = subjectCache.get(key);
  if (mem && mem.expires > Date.now()) return mem.data;
  const disk = (await diskRead<SubjectEntry>(key)) as SubjectEntry | null;
  if (disk && disk.expires > Date.now() && typeof disk.data === "string") {
    subjectCache.set(key, disk);
    return disk.data;
  }
  try {
    const { status, body } = await getJson(`${AONEROOM_DETAIL}?detailPath=${encodeURIComponent(detailPath)}`, "https://h5-api.aoneroom.com/", 12_000);
    if (status !== 200) throw new Error(`aoneroom detail -> ${status}`);
    const json = JSON.parse(body) as { data?: { subject?: { subjectId?: string } }; subject?: { subjectId?: string } };
    const id = json?.data?.subject?.subjectId ?? json?.subject?.subjectId ?? null;
    if (!id) return null;
    const entry: SubjectEntry = { data: id, expires: Date.now() + SUBJECT_TTL_MS };
    subjectCache.set(key, entry);
    void diskWrite(key, entry);
    return id;
  } catch {
    return null;
  }
}

/**
 * Resolve the SupaPlay DUB stream (progressive MP4) for one episode.
 * Requires `Anime.supaplayPath` to be mapped; null otherwise.
 */
export async function supaplayDub(
  malId: number,
  ep: number,
  opts: { fresh?: boolean } = {},
): Promise<SupaplayStream | null> {
  let detailPath: string | null = null;
  try {
    const anime = await db.anime.findUnique({ where: { malId }, select: { supaplayPath: true } });
    detailPath = anime?.supaplayPath?.trim() || null;
  } catch {
    return null;
  }
  if (!detailPath) return null; // not mapped — caller falls through to megaplay

  const key = `stream/${detailPath}/${ep}`;
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

  try {
    const subjectId = await subjectIdFor(detailPath);
    if (!subjectId) return null;
    // multi-season subjects: one SupaPlay subject carries S1-S3 ("Jujutsu
    // Kaisen [English] S1-S3") — Anime.supaplaySeason picks the right one
    // (null = 1). MAL season entries map 1:1 to se numbers.
    let season = 1;
    try {
      const anime = await db.anime.findUnique({ where: { malId }, select: { supaplaySeason: true } });
      season = anime?.supaplaySeason && anime.supaplaySeason > 0 ? anime.supaplaySeason : 1;
    } catch { /* default to 1 */ }
    const url = new URL(FETCH_VIDEO);
    url.searchParams.set("subjectId", String(subjectId));
    url.searchParams.set("se", String(season));
    url.searchParams.set("ep", String(ep));
    url.searchParams.set("detailPath", detailPath);
    url.searchParams.set("proxy", "1");
    const res = await getJson(url.toString(), SUPAPLAY_REFERER, 20_000);
    if (res.status !== 200) throw new Error(`fetchVideo -> ${res.status}`);
    const json = JSON.parse(res.body) as {
      code?: number;
      message?: string;
      data?: { streams?: unknown[] };
      streams?: unknown[];
    };
    if (json.code !== undefined && Number(json.code) !== 0) {
      throw new Error(json.message || "fetchVideo rejected");
    }
    const raw = json?.data?.streams ?? json?.streams ?? [];
    const streams = raw
      .map((s) => s as { url?: string; proxyUrl?: string; resolutionValue?: number; resolution?: string; resolutions?: string })
      .filter((s) => typeof s.url === "string" && s.url)
      .map((s) => ({
        ...s,
        resolutionValue: Number(String(s.resolutionValue ?? s.resolutions ?? s.resolution ?? "0").match(/\d+/)?.[0] ?? 0),
      }));
    if (!streams.length) return null;
    const best = streams.sort((a, b) => b.resolutionValue - a.resolutionValue)[0];
    const stream: SupaplayStream = {
      src: best.url as string,
      subtitles: [],
      resolvedFrom: url.toString(),
      resolution: String(best.resolution || (best.resolutionValue ? `${best.resolutionValue}p` : "Auto")),
    };
    registerStreamHosts(stream);
    const entry: CacheEntry = { data: stream, expires: Date.now() + TTL_MS };
    cache.set(key, entry);
    void diskWrite(key, entry);
    return stream;
  } catch (err) {
    const stale = cache.get(key);
    if (stale) return stale.data;
    console.error("[supaplay]", err instanceof Error ? err.message : err);
    return null;
  }
}

/** SupaPlay's video CDN serves signed URLs — no special Referer wanted. */
function registerStreamHosts(stream: SupaplayStream): void {
  try {
    allowHostWithReferer(new URL(stream.src).hostname, NO_REFERER);
  } catch {
    /* ignore */
  }
}

/* ---- transport --------------------------------------------------------
 * hacker.moviewatchtv.fun sits behind Cloudflare bot scoring: Node's fetch
 * (undici) gets a 403 "Just a moment" challenge even with a browser UA,
 * while curl's TLS fingerprint is served fine (verified). Same pattern as
 * src/lib/jikan.ts: curl first, fetch as the fallback.
 * -------------------------------------------------------------------- */
function curlGetJson(url: string, referer: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "curl",
      [
        "-sS",
        "--max-time",
        String(Math.ceil(timeoutMs / 1000)),
        "-A",
        UA,
        "-H",
        `Referer: ${referer}`,
        "-H",
        "Accept: application/json",
        "-w",
        "\n__STATUS__%{http_code}",
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

async function getJson(url: string, referer: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  try {
    return await curlGetJson(url, referer, timeoutMs);
  } catch {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: referer, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, body: await res.text() };
  }
}
