/**
 * Minimal Jikan v4 (unofficial MyAnimeList API) client.
 *
 * - Server-side only.
 * - Spaces requests out to respect Jikan's rate limits (3 req/s, 60/min).
 * - In-memory cache with per-endpoint TTLs.
 * - Retries once on 429 / transient failures.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = "https://api.jikan.moe/v4";
const MIN_INTERVAL_MS = 700; // stay inside Jikan's published 3 req/s budget
// On Vercel the bundle filesystem is read-only — cache in /tmp there.
const DISK_CACHE_DIR =
  process.env.VERCEL === "1"
    ? join(tmpdir(), "jikan-cache")
    : join(process.cwd(), "db", "jikan-cache");

type CacheEntry = { data: unknown; expires: number };
const cache = new Map<string, CacheEntry>();
const revalidating = new Set<string>();

let lastRequestAt = 0;
let chain: Promise<void> = Promise.resolve();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function schedule<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn);
  // keep the chain alive even if a request fails
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Some runtimes' fetch stacks get 504-shed by Jikan's origin while curl is
 * served fine, so we go through curl first and fall back to fetch.
 */
function curlGet(url: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "curl",
      // NOTE: no --compressed — Jikan's origin 504s when gzip is requested
      ["-sS", "--max-time", String(Math.ceil(timeoutMs / 1000)), "-w", "\n__STATUS__%{http_code}", url],
      { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs + 5_000 },
      (err, stdout, stderr) => {
        const m = stdout.match(/__STATUS__(\d+)\s*$/);
        if (!m) return reject(new Error(stderr || err?.message || "curl failed"));
        resolve({ status: parseInt(m[1], 10), body: stdout.replace(/__STATUS__\d+\s*$/, "") });
      },
    );
  });
}

async function httpGet(url: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  try {
    return await curlGet(url, timeoutMs);
  } catch {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "Accept-Encoding": "identity" },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, body: await res.text() };
  }
}

async function rawGet(path: string, maxTries = 3): Promise<unknown> {
  const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRequestAt));
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();

  let lastStatus = 0;
  for (let tries = 0; tries < maxTries; tries++) {
    const { status, body } = await httpGet(`${BASE}${path}`, 25_000);
    if (status === 200) return JSON.parse(body);
    lastStatus = status;
    if (status === 404) throw new Error(`Jikan ${path} -> 404`);
    // 429 / 5xx: Jikan sheds load with 504s — back off (3s, 6s, …)
    if (tries < maxTries - 1) {
      await sleep(3_000 * (tries + 1));
      lastRequestAt = Date.now();
    }
  }
  throw new Error(`Jikan ${path} -> ${lastStatus}`);
}

const TTL_MS: Array<[RegExp, number]> = [
  [/^\/anime\/\d+\/full/, 6 * 60 * 60 * 1000],
  [/^\/anime\/\d+\/episodes/, 15 * 60 * 1000],
  [/^\/anime\/\d+$/, 10 * 60 * 1000], // plain lookup: keep episode counts fresh
  [/^\/top\/anime/, 10 * 60 * 1000],
  [/^\/seasons\/now/, 30 * 60 * 1000],
  [/^\/anime\?/, 10 * 60 * 1000],
];
const DEFAULT_TTL = 30 * 60 * 1000;

function ttlFor(path: string): number {
  for (const [re, ttl] of TTL_MS) if (re.test(path)) return ttl;
  return DEFAULT_TTL;
}

function diskPath(path: string): string {
  const key = createHash("sha1").update(path).digest("hex").slice(0, 24);
  return join(DISK_CACHE_DIR, `${key}.json`);
}

async function diskRead(path: string): Promise<CacheEntry | null> {
  try {
    const raw = await readFile(diskPath(path), "utf8");
    return JSON.parse(raw) as CacheEntry;
  } catch {
    return null;
  }
}

async function diskWrite(path: string, entry: CacheEntry): Promise<void> {
  try {
    await mkdir(DISK_CACHE_DIR, { recursive: true });
    await writeFile(diskPath(path), JSON.stringify(entry), "utf8");
  } catch {
    /* best-effort */
  }
}

/** GET a Jikan path with queue + cache. Returns null on 404, throws on network failure. */
export async function jikan<T = unknown>(
  path: string,
  opts: { fresh?: boolean; retries?: number; disk?: boolean } = {},
): Promise<T | null> {
  const hit = cache.get(path);
  if (!opts.fresh && hit && hit.expires > Date.now()) return hit.data as T;

  if (opts.disk && !opts.fresh) {
    const entry = await diskRead(path);
    if (entry) {
      if (entry.expires > Date.now()) {
        cache.set(path, entry);
        return entry.data as T;
      }
      // expired: answer from the stale copy now, quietly refresh in the background
      if (!revalidating.has(path)) {
        revalidating.add(path);
        void schedule(() => rawGet(path, 2))
          .then((data) => {
            const fresh: CacheEntry = { data, expires: Date.now() + ttlFor(path) };
            cache.set(path, fresh);
            return diskWrite(path, fresh);
          })
          .catch(() => undefined)
          .finally(() => revalidating.delete(path));
      }
      cache.set(path, entry);
      return entry.data as T;
    }
  }

  const maxTries = 1 + Math.max(0, opts.retries ?? 2);
  try {
    const data = await schedule(() => rawGet(path, maxTries));
    const entry: CacheEntry = { data, expires: Date.now() + ttlFor(path) };
    cache.set(path, entry);
    if (opts.disk) void diskWrite(path, entry);
    return data as T;
  } catch (err) {
    if (String(err).includes("-> 404")) return null;
    // stale-while-error: serve expired cache (memory, then disk) if we have it
    const stale = cache.get(path);
    if (stale) return stale.data as T;
    if (opts.disk) {
      const entry = await diskRead(path);
      if (entry) return entry.data as T;
    }
    console.error("[jikan]", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Like `jikan` but bypasses the read cache — for freshness-critical checks. */
export async function jikanFresh<T = unknown>(path: string): Promise<T | null> {
  return jikan<T>(path, { fresh: true });
}

/** Like `jikan` but unwraps the `{ data: ... }` envelope used by single-resource endpoints. */
export async function jikanOne<T = unknown>(path: string, opts: { fresh?: boolean; retries?: number } = {}): Promise<T | null> {
  const res = await jikan<{ data?: T }>(path, opts);
  return res?.data ?? null;
}

/** Unwrapped + cache-bypassing — for freshness-critical single-resource reads. */
export async function jikanOneFresh<T = unknown>(path: string, opts: { retries?: number } = {}): Promise<T | null> {
  return jikanOne<T>(path, { fresh: true, retries: opts.retries });
}

/* ------------------------------- types ------------------------------- */

export interface JikanImageSet {
  jpg?: { image_url?: string; large_image_url?: string };
  webp?: { image_url?: string; large_image_url?: string };
}

export interface JikanAnime {
  mal_id: number;
  title: string;
  title_english?: string | null;
  images?: JikanImageSet;
  synopsis?: string | null;
  type?: string | null;
  rating?: string | null;
  status?: string | null;
  airing?: boolean;
  season?: string | null;
  year?: number | null;
  episodes?: number | null;
  duration?: string | null;
  score?: number | null;
  rank?: number | null;
  popularity?: number | null;
  members?: number | null;
  favorites?: number | null;
  genres?: Array<{ name: string }>;
  themes?: Array<{ name: string }>;
  studios?: Array<{ name: string }>;
  trailer?: {
    youtube_id?: string | null;
    images?: { maximum_image_url?: string };
  };
  relations?: Array<{
    relation: string;
    entry: Array<{ mal_id: number; name: string; type: string }>;
  }>;
}

export function posterUrl(a: JikanAnime | null | undefined): string | null {
  const img = a?.images?.webp?.large_image_url || a?.images?.jpg?.large_image_url || a?.images?.jpg?.image_url;
  return img ?? null;
}

export function bannerUrl(a: JikanAnime | null | undefined): string | null {
  return a?.trailer?.images?.maximum_image_url ?? posterUrl(a);
}

export function durationToMinutes(d: string | null | undefined): number | null {
  if (!d) return null;
  const m = d.match(/(\d+)\s*min/);
  if (m) return parseInt(m[1], 10);
  const h = d.match(/(\d+)\s*hr/);
  if (h) return parseInt(h[1], 10) * 60;
  return null;
}

/** "PG-13 - Teens 13 or older" -> "PG-13" */
export function shortRating(r: string | null | undefined): string | null {
  if (!r) return null;
  return r.split(" - ")[0]?.trim() || null;
}
