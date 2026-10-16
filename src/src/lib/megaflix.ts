/**
 * MegaFlix Anime Player (megaflix.buzz) — the user-requested AniList-keyed
 * embed fallback (SUB + DUB).
 *
 * The Yomi-documented embed pattern (same family as megaplay.buzz's
 * /stream/ani/ route):
 *
 *   https://www.megaflix.buzz/stream/ani/{anilistId}/{ep}/{sub|dub}
 *
 * Their edge answers a "Netherlands network endpoint" placeholder to every
 * vantage point we can test from (app server, neutral fetchers) — so no
 * stream extraction and no coverage oracle is possible from here. The
 * pre-flight below detects that placeholder DEFINITIVELY (it IS the whole
 * body) and the walk chain then skips MegaFlix instead of stranding the
 * viewer on a dead embed; if their gate ever opens (or a viewer's own
 * network gets the real page) the embed starts working with zero changes.
 *
 * Server-side only. Mirrors lib/megaplay.ts's verdict-cache shapes.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anilistIdForMal } from "@/lib/anivexa";
import type { Lang } from "@/lib/zoko";

const MEGAFLIX_BASE = "https://www.megaflix.buzz";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** The placeholder their NL-gated edge serves to non-NL networks. */
const GATE_PLACEHOLDER = "netherlands network endpoint";

const VERDICT_TTL_MS = 24 * 3600 * 1000;
const URL_TTL_MS = 24 * 3600 * 1000; // anilistId mapping — stable

const DISK_CACHE_DIR =
  process.env.VERCEL === "1" ? join(tmpdir(), "megaflix") : join(process.cwd(), "db", "megaflix");

type VerdictEntry = { data: boolean; expires: number };
type UrlEntry = { data: string; expires: number };
const verdicts = new Map<string, VerdictEntry>();
const urlCache = new Map<string, UrlEntry>();

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

/** MegaFlix's AniList-keyed embed URL for one episode. */
export function megaflixEmbedUrl(anilistId: number, ep: number, lang: Lang): string {
  return `${MEGAFLIX_BASE}/stream/ani/${anilistId}/${ep}/${lang}`;
}

/** AniList id → embed URL (cached; null when the anime has no AniList map). */
export async function megaflixUrlForMal(malId: number, ep: number, lang: Lang): Promise<string | null> {
  const key = `url/${malId}/${lang}`;
  const mem = urlCache.get(key);
  if (mem && mem.expires > Date.now()) return megaflixEmbedUrl(Number(mem.data), ep, lang);
  const disk = (await diskRead<UrlEntry>(key)) as UrlEntry | null;
  if (disk && disk.expires > Date.now() && Number.isFinite(Number(disk.data)) && Number(disk.data) > 0) {
    urlCache.set(key, disk);
    return megaflixEmbedUrl(Number(disk.data), ep, lang);
  }
  try {
    const anilistId = await anilistIdForMal(malId);
    if (!anilistId) return null;
    const entry: UrlEntry = { data: String(anilistId), expires: Date.now() + URL_TTL_MS };
    urlCache.set(key, entry);
    void diskWrite(key, entry);
    return megaflixEmbedUrl(anilistId, ep, lang);
  } catch {
    return null;
  }
}

async function cacheVerdict(key: string, verdict: boolean): Promise<void> {
  const entry: VerdictEntry = { data: verdict, expires: Date.now() + VERDICT_TTL_MS };
  verdicts.set(key, entry);
  await diskWrite(key, entry);
}

/**
 * Does MegaFlix's embed page actually serve a player for this episode?
 *   true  = the page returned real HTML (not the NL placeholder)
 *   false = DEFINITIVE dead-from-here: the placeholder body (their gate) or
 *           a non-200 — the walk chain must skip MegaFlix
 *   null  = network trouble — never cached, never blocking
 */
export async function verifyMegaflixEmbed(
  malId: number,
  ep: number,
  lang: Lang = "dub",
  opts: { fresh?: boolean } = {},
): Promise<boolean | null> {
  const key = `verdict/${malId}/${ep}/${lang}`;
  if (!opts.fresh) {
    const mem = verdicts.get(key);
    if (mem && mem.expires > Date.now()) return mem.data;
    const disk = (await diskRead<VerdictEntry>(key)) as VerdictEntry | null;
    if (disk && disk.expires > Date.now() && typeof disk.data === "boolean") {
      verdicts.set(key, disk);
      return disk.data;
    }
  }
  try {
    const url = await megaflixUrlForMal(malId, ep, lang);
    if (!url) {
      await cacheVerdict(key, false); // no AniList map — never reachable
      return false;
    }
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html", Referer: `${MEGAFLIX_BASE}/` },
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      await cacheVerdict(key, false);
      return false;
    }
    const body = (await res.text()).toLowerCase();
    const dead = body.includes(GATE_PLACEHOLDER) || body.length < 512;
    await cacheVerdict(key, !dead);
    return !dead;
  } catch {
    return null;
  }
}
