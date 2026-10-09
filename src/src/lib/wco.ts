/**
 * WCO (wcostream) resolver — South Park's playback source.
 *
 * South Park is a western cartoon: it has no AniList mapping, so the whole
 * AniList/Jikan/Zoko machinery (which keys on MAL ids those sites resolve)
 * can't see it. WCO carries every season, the movie and the specials, so the
 * app grows a dedicated source for it (Anime.source = "wco").
 *
 * Verified chain (2026-10-09, from both the sandbox and the docs in
 * wcoflix/wcostream episode pages):
 *   1. episode page  https://www.wcostream.tv/{slug}
 *      -> iframe src "https://embed.wcostream.com/inc/embed/index.php
 *         ?file={file}&fullhd=1&pid={pid}&h={h}&t={t}&embed=neptun"
 *   2. getvidlink    https://embed.wcostream.com/inc/embed/getvidlink.php
 *         ?v=neptun/{file with .flv -> .mp4}&embed=neptun&fullhd=1
 *      headers: X-Requested-With: XMLHttpRequest (without it -> 403),
 *               Referer: .../video-js.php (the page the player AJAX runs in)
 *      -> { enc, hd, fhd, cdn, server, sub }
 *   3. final         GET {server}/getvid?evid={enc}&json
 *      -> JSON string "https://uNN.wcostream.com/getvid?evid=..."
 *      -> direct MP4 (video/mp4, Range 206) — the <video> element plays it
 *         cross-origin without a proxy.
 *
 * The embed's interstitial (10s countdown -> video-js.php) is a UI gate for
 * browser visitors; server-side callers can skip straight to video-js.php's
 * AJAX — only the XRW + Referer headers matter.
 */

import { execFile } from "node:child_process";
import { db } from "@/lib/db";
import { WCO_SP_EPISODES, WCO_SP_SEASON_RANGES, WCO_SP_TOTAL, WCO_SP_DEAD_SLUGS, type WcoEpisode } from "@/lib/wco-sp-episodes";

const SITE = "https://www.wcostream.tv";
const EMBED_BASE = "https://embed.wcostream.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const VIDLINK_REFERER = `${EMBED_BASE}/inc/embed/video-js.php`;
/** Stream hosts the playback proxy may be asked for (Range retries, downloads). */
export const WCO_REFERER = "https://www.wcostream.tv/";

const TTL_MS = 4 * 60 * 1000; // getvid tokens expire after a few minutes — resolve per play, cache briefly
const NEG_TTL_MS = 30 * 60 * 1000; // login-gated pages stay gated for a while

type CacheEntry = { data: unknown; expires: number };
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<WcoStream | null>>();

export interface WcoStream {
  src: string;
  subtitles: Array<{ lang: string; label: string; src: string }>;
}

export function wcoEpisodeByNumber(ep: number): WcoEpisode | null {
  return WCO_SP_EPISODES.find((e) => e.number === ep) ?? null;
}

/**
 * Per-entry episode lookup (Task 27: the franchise is spread out — one entry
 * per season, like every other show). malId = 999900 + season:
 *   1..29 -> that season's episodes keyed by their REAL per-season number
 *            (S28 starts at 2 — WCO never carried S28E1)
 *   0     -> the Movies & Specials bucket (1..3)
 * 999999 (the retired single-entry aggregator) still resolves by flat number
 * so stale deep links / session stacks keep playing.
 */
export function wcoEpisodeForEntry(malId: number, ep: number): WcoEpisode | null {
  const hit = wcoEpisodeForEntryRaw(malId, ep);
  // dead-source guard: the page/file is gone on WCO's side (see the set's
  // docs) — refuse the slug so playback fails honestly instead of handing
  // the player a URL that serves nothing
  return hit && !WCO_SP_DEAD_SLUGS.has(hit.slug) ? hit : null;
}

function wcoEpisodeForEntryRaw(malId: number, ep: number): WcoEpisode | null {
  if (malId === 999999) return wcoEpisodeByNumber(ep);
  const season = malId - 999900;
  if (season >= 1 && season <= 29) {
    return WCO_SP_EPISODES.find((e) => e.season === season && e.episode === ep) ?? null;
  }
  if (season === 0) {
    const specials = WCO_SP_EPISODES.filter((e) => e.season == null);
    return specials[ep - 1] ?? null;
  }
  return null;
}

export function wcoSeasonRanges(): Array<{ season: number; from: number; to: number }> {
  return WCO_SP_SEASON_RANGES;
}

async function fetchText(url: string, headers: Record<string, string> = {}, timeoutMs = 15_000): Promise<string | null> {
  const out = await curlGet(url, headers, timeoutMs);
  return out && out.status === 200 ? out.body : null;
}

/**
 * curl-exec transport — the WCO network fingerprint-gates plain server
 * fetches (undici/bun TLS handshakes answer 403 where curl 200s; verified
 * 2026-10-09 against both wcoflix.tv and wcostream.tv). Same pattern the
 * SupaPlay resolver uses for its fingerprint-sensitive endpoints.
 */
function curlGet(url: string, headers: Record<string, string> = {}, timeoutMs = 15_000): Promise<{ status: number; body: string } | null> {
  const args = [
    "-sS",
    "--max-time",
    String(Math.ceil(timeoutMs / 1000)),
    "-A",
    UA,
    "--compressed",
    "-w",
    "\n__STATUS__%{http_code}",
    url,
  ];
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  return new Promise((resolve) => {
    execFile(
      "curl",
      args,
      { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs + 5_000 },
      (err, stdout, stderr) => {
        const m = stdout.match(/__STATUS__(\d+)\s*$/);
        if (!m) return resolve(null); // transport failure (DNS, timeout)
        resolve({ status: parseInt(m[1], 10), body: stdout.replace(/__STATUS__\d+\s*$/, "") });
      },
    );
  });
}

/**
 * One episode page -> the signed embed iframe params. The `file` param and
 * the pid/h/t signature come from the page's iframe tag; the getvidlink
 * `v` path is the file path re-rooted under neptun/ with a .mp4 suffix.
 */
async function resolveEmbedParams(slug: string): Promise<{ v: string; pid: string } | null> {
  const html = await fetchText(`${SITE}/${slug}`);
  if (!html) return null;
  const m = html.match(/embed\.wcostream\.com\/inc\/embed\/index\.php\?file=([^"&]+)&[^"]*?pid=(\d+)/);
  if (!m) return null;
  const file = decodeURIComponent(m[1]);
  // file "neptun2/South.Park.S01...flv" -> v "neptun/neptun2/South.Park...mp4"
  const v = `neptun/${file.replace(/\.flv$/i, ".mp4")}`;
  return { v, pid: m[2] };
}

interface VidLink {
  enc?: string;
  hd?: string;
  fhd?: string;
  cdn?: string;
  server?: string;
  sub?: string | null;
}

async function getvidlink(v: string, fullhd: boolean): Promise<VidLink | null> {
  const url = `${EMBED_BASE}/inc/embed/getvidlink.php?v=${encodeURIComponent(v)}&embed=neptun${fullhd ? "&fullhd=1" : ""}`;
  const out = await curlGet(
    url,
    {
      Accept: "application/json, text/javascript, */*; q=0.01",
      // the two headers that matter: jQuery's AJAX marker + the player page
      "X-Requested-With": "XMLHttpRequest",
      Referer: VIDLINK_REFERER,
    },
    15_000,
  );
  if (!out || out.status !== 200) return null;
  try {
    return JSON.parse(out.body) as VidLink;
  } catch {
    return null;
  }
}

/** {server}/getvid?evid={enc}&json -> the direct MP4 URL (JSON-encoded string). */
async function getvidFinal(server: string | undefined, enc: string | undefined): Promise<string | null> {
  if (!server || !enc) return null;
  const out = await curlGet(`${server}/getvid?evid=${encodeURIComponent(enc)}&json`, { Referer: `${EMBED_BASE}/` }, 15_000);
  if (!out || out.status !== 200) return null;
  let url = out.body.trim();
  try {
    const parsed = JSON.parse(url);
    if (typeof parsed === "string") url = parsed;
  } catch {
    /* already a plain URL */
  }
  url = url.replace(/\\\//g, "/");
  if (!/^https?:\/\//.test(url)) return null;
  // WCO quirk (Post COVID specials): a file whose CDN node is unassigned
  // comes back as "https://.wcostream.com/getvid?evid=..." — an EMPTY host
  // label. Nothing can ever fetch that (and every fallback host dead-ends);
  // treat it as unresolvable so the episode 404s instead of the player
  // silently showing nothing.
  if (/^https?:\/\/\./.test(url)) return null;
  return url;
}

/**
 * Resolve one episode of a WCO entry (malId = 999900 + season) to a direct
 * MP4. Episodes imported by the freshness scrape aren't in the baked
 * manifest — their slug ships on the Episode row (Episode.slug).
 */
export async function wcoStream(malId: number, ep: number): Promise<WcoStream | null> {
  const target = wcoEpisodeForEntry(malId, ep);
  let slug = target?.slug ?? null;
  if (!slug) {
    const row = await db.episode
      .findUnique({
        where: { animeId_number_lang: { animeId: malId, number: ep, lang: "sub" } },
        select: { slug: true },
      })
      .catch(() => null);
    slug = row?.slug ?? null;
  }
  if (!slug) return null;
  return wcoStreamSlug(slug, `sp/${malId}/${ep}`);
}

/** Resolve one WCO page slug to a direct MP4. Cached ~4 min, negatives 30. */
export async function wcoStreamSlug(slug: string, key: string): Promise<WcoStream | null> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.data as WcoStream;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const job = (async (): Promise<WcoStream | null> => {
    // FHD first, SD fallback — getvidlink returns per-quality blobs; the
    // player picks whatever resolves
    const params = await resolveEmbedParams(slug);
    if (!params) {
      // login-gated page (WCO gates the movies / some specials behind an
      // account) — negative-cache so those episodes 404 fast instead of
      // re-scraping on every hit
      cache.set(key, { data: null, expires: Date.now() + NEG_TTL_MS });
      return null;
    }
    for (const fullhd of [true, false]) {
      const link = await getvidlink(params.v, fullhd);
      if (!link) continue;
      // quality ladder: fhd -> hd -> enc (the player's own order)
      const subtitles: WcoStream["subtitles"] = [];
      if (link.sub) subtitles.push({ lang: "en", label: "English", src: `${link.server}/getvid?evid=${link.sub}` });
      for (const enc of [link.fhd, link.hd, link.enc]) {
        const final = await getvidFinal(link.server, enc);
        if (final) {
          const out: WcoStream = { src: final, subtitles };
          cache.set(key, { data: out, expires: Date.now() + TTL_MS });
          return out;
        }
      }
    }
    return null;
  })();

  inFlight.set(key, job);
  try {
    return await job;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Season 29 is AIRING — refresh the baked manifest from the live series
 * page and return any NEW episodes (caller imports them into the Episode
 * table). Bounded work: one page fetch, slug-diff against the baked list.
 */
export async function wcoFreshEpisodes(): Promise<WcoEpisode[]> {
  const html = await fetchText(`${SITE}/anime/south-park`, {}, 20_000);
  if (!html) return [];
  const seen = new Set(WCO_SP_EPISODES.map((e) => e.slug));
  const fresh: WcoEpisode[] = [];
  const items = html.matchAll(/href="\/(south-park-[^"]+)"[^>]*data-season="[^"]*"[^>]*data-lang="[^"]*"[^>]*>\s*<span>([^<]+)<\/span>/g);
  for (const item of items) {
    const slug = item[1].replace("south-park-season-season-", "south-park-season-");
    if (seen.has(slug)) continue;
    seen.add(slug);
    const sm = slug.match(/^south-park-season-(\d+)-episode-(\d+)-(.*)$/);
    const title = item[2].trim();
    if (sm) {
      const t = title.replace(/^(?:Season\s*\d+\s*)?Episode\s*\d+[\s:\-]*/, "").trim() || title;
      fresh.push({ number: 0, season: parseInt(sm[1], 10), episode: parseInt(sm[2], 10), title: t, slug });
    } else {
      fresh.push({ number: 0, season: null, episode: null, title, slug });
    }
  }
  return fresh;
}

export { WCO_SP_TOTAL };
