/**
 * LM2 (lookmovie2) resolver — South Park's fallback playback source and the
 * supplier of its English closed captions.
 *
 * WHY: WCO (the primary source) lost real episodes (S23E10 "Christmas Snow"
 * page pulled; both Post COVID specials' CDN nodes unassigned) and ships no
 * caption tracks at all for the show (getvidlink sub=null on every probed
 * episode). LM2 mirrors the whole series — 336 entries, S23E10 included and
 * verified playing — and attaches OpenSubtitles-sourced English VTTs to
 * every episode the catalog carries.
 *
 * Verified chain (2026-10-09):
 *   1. show session  GET /shows/play/1689878855-south-park-1997
 *      -> window.show_storage { id_show, hash, expires } (hash lives ~3.5h)
 *   2. episode access GET /api/v1/security/episode-access
 *         ?id_episode={id}&hash={hash}&expires={expires}
 *      -> { success, streams: {"480p": m3u8|null, ...}, subtitles: [...] }
 *   3. stream        the m3u8 on srvNNN.horrowing.cyou — plain signed URLs,
 *      no Referer needed (master + segments verified 200 with bytes)
 *   4. movies        /movies/play/{slug} -> window.movie_storage { id_movie,
 *      hash, expires } -> /api/v1/security/movie-access (same shape)
 *
 * HEALTH NOTE (verified 2026-10-09): LM2's SHOW-episode storage serves real
 * bytes, but its MOVIE storage answers "WRONG HASH!" (200-wrapped error) for
 * every South Park movie right now. The resolver treats any master whose
 * body does not start with "#EXTM3U" as dead, so those episodes fall through
 * honestly — and if LM2 fixes their storage the fallback starts working with
 * zero code changes.
 */

import { execFile } from "node:child_process";

const SITE = "https://www.lookmovie2.to";
const SHOW_PLAY = `${SITE}/shows/play/1689878855-south-park-1997`;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const SESSION_TTL_MS = 60 * 60 * 1000; // refresh the show session hourly (hash lives ~3.5h)
const STREAM_TTL_MS = 4 * 60 * 1000; // access tokens are per-resolve, like WCO's
const NEG_TTL_MS = 5 * 60 * 1000; // LM2's storage pool is flaky (rate varies over time) — retry soon, not in 30 min

type CacheEntry = { data: unknown; expires: number };
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<Lm2Stream | null>>();

export interface Lm2Stream {
  src: string;
  subtitles: Array<{ lang: string; label: string; src: string }>;
}

/**
 * Baked episode map (season -> episode -> id_episode) from LM2's show
 * catalog, extracted 2026-10-09 (336 entries: S0E45 = the movie listed as an
 * episode + all TV seasons incl. S23E10 "Christmas Snow").
 */
export const LM2_SP_EPISODE_IDS: Record<number, Record<number, number>> = {
  0: { 45: 385169 },
  1: { 1: 59266, 2: 59265, 3: 59264, 4: 59262, 5: 59261, 6: 59263, 7: 59260, 8: 59259, 9: 59258, 10: 59257, 11: 59256, 12: 59255, 13: 59254 },
  2: { 1: 59250, 2: 59253, 3: 59252, 4: 59251, 5: 59248, 6: 59249, 7: 59247, 8: 59246, 9: 59244, 10: 59245, 11: 59243, 12: 59241, 13: 59242, 14: 59239, 15: 59238, 16: 59237, 17: 59236, 18: 59240 },
  3: { 1: 59235, 2: 59234, 3: 59233, 4: 59232, 5: 59231, 6: 59230, 7: 59229, 8: 59228, 9: 59227, 10: 59224, 11: 59225, 12: 59226, 13: 59221, 14: 59222, 15: 59223, 16: 59220, 17: 59219 },
  4: { 1: 59218, 2: 59217, 3: 59216, 4: 59215, 5: 59212, 6: 59213, 7: 59214, 8: 59210, 9: 59209, 10: 59206, 11: 59205, 12: 59204, 13: 59202, 14: 59203, 15: 59201, 16: 59126, 17: 59131 },
  5: { 1: 59130, 2: 59127, 3: 59129, 4: 59125, 5: 59128, 6: 59124, 7: 59123, 8: 59122, 9: 59121, 10: 59119, 11: 59118, 12: 59116, 13: 59115, 14: 59114 },
  6: { 1: 59113, 2: 59112, 3: 59111, 4: 59110, 5: 59109, 6: 59108, 7: 59107, 8: 59106, 9: 59105, 10: 59104, 11: 59103, 12: 59102, 13: 59101, 14: 59100, 15: 59099, 16: 59098, 17: 59097 },
  7: { 1: 59096, 2: 59095, 3: 59094, 4: 59093, 5: 59092, 6: 59091, 7: 59090, 8: 59089, 9: 59088, 10: 59087, 11: 59086, 12: 59085, 13: 59084, 14: 59083, 15: 59082 },
  8: { 1: 59081, 2: 59080, 3: 59079, 4: 59078, 5: 59077, 6: 59076, 7: 59075, 8: 59074, 9: 59073, 10: 59072, 11: 59071, 12: 59070, 13: 59069, 14: 59068 },
  9: { 1: 59067, 2: 59066, 3: 59065, 4: 59064, 5: 59063, 6: 59062, 7: 59061, 8: 59060, 9: 59059, 10: 59058, 11: 59057, 12: 59056, 13: 59055, 14: 59054 },
  10: { 1: 59053, 2: 59052, 3: 59051, 4: 59050, 5: 59049, 6: 59048, 7: 59047, 8: 59046, 9: 59045, 10: 59044, 11: 59043, 12: 59042, 13: 59041, 14: 59040 },
  11: { 1: 59039, 2: 59038, 3: 59037, 4: 59036, 5: 59035, 6: 59034, 7: 59033, 8: 59032, 9: 59031, 10: 59030, 11: 59029, 12: 59028, 13: 59027, 14: 59026 },
  12: { 1: 59025, 2: 59024, 3: 59023, 4: 59022, 5: 59021, 6: 59020, 7: 59019, 8: 59018, 9: 59017, 10: 59016, 11: 59015, 12: 59014, 13: 59013, 14: 59012 },
  13: { 1: 59011, 2: 59010, 3: 59009, 4: 59008, 5: 59007, 6: 59006, 7: 59005, 8: 59004, 9: 59003, 10: 59002, 11: 59001, 12: 59000, 13: 58999, 14: 58998 },
  14: { 1: 58997, 2: 58996, 3: 58995, 4: 58994, 5: 58993, 6: 58992, 7: 58991, 8: 58990, 9: 58989, 10: 58988, 11: 58987, 12: 58986, 13: 58985, 14: 58984 },
  15: { 1: 58983, 2: 58982, 3: 58981, 4: 58980, 5: 58979, 6: 58978, 7: 58977, 8: 58976, 9: 58975, 10: 58974, 11: 58973, 12: 58972, 13: 58971, 14: 58970 },
  16: { 1: 58969, 2: 58968, 3: 58967, 4: 58966, 5: 58965, 6: 58964, 7: 58963, 8: 58962, 9: 58961, 10: 58960, 11: 58959, 12: 58958, 13: 58957, 14: 58956 },
  17: { 1: 58955, 2: 58954, 3: 58953, 4: 58952, 5: 58951, 6: 58950, 7: 58949, 8: 58948, 9: 58947, 10: 58946 },
  18: { 1: 58945, 2: 58944, 3: 58943, 4: 58942, 5: 58941, 6: 58940, 7: 58939, 8: 58938, 9: 58937, 10: 58936 },
  19: { 1: 58935, 2: 58934, 3: 58933, 4: 58932, 5: 58931, 6: 58930, 7: 58929, 8: 58928, 9: 58927, 10: 58926 },
  20: { 1: 58925, 2: 58924, 3: 58923, 4: 58922, 5: 58921, 6: 58920, 7: 58919, 8: 58918, 9: 58917, 10: 58916 },
  21: { 1: 58915, 2: 58914, 3: 58913, 4: 58912, 5: 58911, 6: 58910, 7: 58909, 8: 58908, 9: 58907, 10: 58906 },
  22: { 1: 58905, 2: 58904, 3: 58903, 4: 58902, 5: 58901, 6: 58900, 7: 58899, 8: 58898, 9: 58897, 10: 58896 },
  23: { 1: 58158, 2: 58071, 3: 58532, 4: 59815, 5: 62153, 6: 63723, 7: 65906, 8: 69098, 9: 70517, 10: 71957 },
  24: { 0: 156660, 1: 137488, 2: 288083 },
  25: { 1: 160869, 2: 161657, 3: 162405, 4: 163729, 5: 164654, 6: 165104 },
  26: { 1: 213454, 2: 214130, 3: 216622, 4: 217767, 5: 219818, 6: 220672 },
  27: { 1: 333249, 2: 335692, 3: 340975, 4: 346061, 5: 353311, 6: 360889 },
  28: { 1: 360887, 2: 366205, 3: 369741, 4: 374195, 5: 378057 },
  29: { 1: 457463, 2: 460249 },
};

/**
 * Movies & WCO-dead specials -> LM2 movie play slugs. Our Movies & Specials
 * bucket (999900) orders eps 1..3 as Streaming Wars Part 2, Streaming Wars,
 * Bigger Longer & Uncut (the WCO manifest order). The two Post COVID
 * specials sit in S24 (WCO slugs pulled/dead) — LM2 carries them as movies.
 * HEALTH: LM2's movie storage answered WRONG HASH for every SP title on
 * 2026-10-09 — these stay wired so playback self-heals when fixed upstream.
 */
export const LM2_SP_MOVIE_SLUGS: Record<string, string> = {
  "0/1": "21198156-south-park-the-streaming-wars-part-2-2022",
  "0/2": "15783698-south-park-the-streaming-wars-2022",
  "0/3": "0158983-south-park-bigger-longer-amp-uncut-1999",
  "24/3": "15178196-south-park-post-covid-2021",
  "24/4": "16375288-south-park-post-covid-covid-returns-2021",
};

function curlGet(url: string, headers: Record<string, string> = {}, timeoutMs = 15_000): Promise<{ status: number; body: string } | null> {
  const args = ["-sS", "--max-time", String(Math.ceil(timeoutMs / 1000)), "-A", UA, "--compressed", "-w", "\n__STATUS__%{http_code}", url];
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  return new Promise((resolve) => {
    execFile("curl", args, { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs + 5_000 }, (err, stdout) => {
      const m = stdout.match(/__STATUS__(\d+)\s*$/);
      if (!m) return resolve(null);
      resolve({ status: parseInt(m[1], 10), body: stdout.replace(/__STATUS__\d+\s*$/, "") });
    });
  });
}

/** The show session's hash/expires — the episode-access signature. */
async function showSession(): Promise<{ hash: string; expires: string } | null> {
  const hit = cache.get("session");
  if (hit && hit.expires > Date.now()) return hit.data as { hash: string; expires: string };
  const out = await curlGet(SHOW_PLAY, {}, 20_000);
  if (!out || out.status !== 200) return null;
  const hash = out.body.match(/hash:\s*'([^']+)'/)?.[1];
  const expires = out.body.match(/expires:\s*(\d+)/)?.[1];
  if (!hash || !expires) return null;
  const session = { hash, expires };
  cache.set("session", { data: session, expires: Date.now() + SESSION_TTL_MS });
  return session;
}

interface AccessPayload {
  success?: boolean;
  streams?: Record<string, string | null>;
  subtitles?: Array<{ language?: string; file?: string }>;
}

/**
 * LM2's storage cluster is PARTIALLY broken: the same access token answers
 * alternately with a live HLS master and a 200-wrapped "WRONG HASH!" text
 * (~1-in-3 live, verified by repeated probes 2026-10-09). Resolving = retry
 * access until a master whose body starts with #EXTM shows up.
 */
async function liveStreamFromAccess(fetchPayload: () => Promise<AccessPayload | null>, attempts = 10): Promise<{ src: string } | null> {
  for (let i = 0; i < attempts; i++) {
    const payload = await fetchPayload();
    if (!payload?.success || !payload.streams) continue;
    // key shapes differ between endpoints ("480" vs "480p") — normalize by digits
    const byQuality = Object.entries(payload.streams)
      .map(([k, v]) => [k.replace(/\D/g, ""), v] as const)
      .filter(([q, v]) => v && /^https?:\/\//.test(v) && ["1080", "720", "480", "360"].includes(q))
      .sort((a, b) => Number(b[0]) - Number(a[0]));
    for (const [, url] of byQuality) {
      const out = await curlGet(url as string, {}, 20_000);
      if (out && out.status === 200 && out.body.trimStart().startsWith("#EXTM")) return { src: url as string };
    }
  }
  return null;
}

/**
 * One episode-access call. Returns the raw payload so the caption harvester
 * (scripts/sp-caption-harvest.mjs) can reach the subtitle list too.
 */
export async function lm2EpisodeAccess(idEpisode: number, referer = SHOW_PLAY): Promise<AccessPayload | null> {
  const session = await showSession();
  if (!session) return null;
  const out = await curlGet(
    `${SITE}/api/v1/security/episode-access?id_episode=${idEpisode}&hash=${session.hash}&expires=${session.expires}`,
    { Referer: referer, "X-Requested-With": "XMLHttpRequest" },
    20_000,
  );
  if (!out || out.status !== 200) return null;
  try {
    return JSON.parse(out.body) as AccessPayload;
  } catch {
    return null;
  }
}

/** (999900+season, ep) -> LM2 episode id, or null. */
export function lm2EpisodeId(malId: number, ep: number): number | null {
  const season = malId - 999900;
  return LM2_SP_EPISODE_IDS[season]?.[ep] ?? null;
}

/** Resolve one SP episode (or special) on LM2 to a proxied HLS stream. */
export async function lm2Stream(malId: number, ep: number): Promise<Lm2Stream | null> {
  const key = `stream/${malId}/${ep}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.data as Lm2Stream;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const job = (async (): Promise<Lm2Stream | null> => {
    const season = malId - 999900;
    const idEpisode = lm2EpisodeId(malId, ep);
    const slug = idEpisode == null ? LM2_SP_MOVIE_SLUGS[`${season}/${ep}`] : undefined;
    if (idEpisode == null && !slug) return null;
    const fetchPayload = () => (idEpisode != null ? lm2EpisodeAccess(idEpisode) : lm2MovieAccess(slug!));
    const live = await liveStreamFromAccess(fetchPayload);
    if (!live) return null;
    // English captions ride the app's own /api/captions/sp route (vendored
    // SpCaption) — LM2's /storage4 VTT paths are session-bound and useless
    // for the player.
    return { src: live.src, subtitles: [] };
  })();

  inFlight.set(key, job);
  try {
    const data = await job;
    cache.set(key, { data, expires: Date.now() + (data ? STREAM_TTL_MS : NEG_TTL_MS) });
    return data;
  } finally {
    inFlight.delete(key);
  }
}

/** Movie-access session: the movie play page's own movie_storage hash. */
async function lm2MovieAccess(slug: string): Promise<AccessPayload | null> {
  const page = await curlGet(`${SITE}/movies/play/${slug}`, {}, 20_000);
  if (!page || page.status !== 200) return null;
  const id = page.body.match(/id_movie:\s*["']?(\d+)/)?.[1];
  const hash = page.body.match(/hash:\s*["']([^"']+)["']/)?.[1];
  const expires = page.body.match(/expires:\s*["']?(\d+)/)?.[1];
  if (!id || !hash || !expires) return null;
  const out = await curlGet(
    `${SITE}/api/v1/security/movie-access?id_movie=${id}&hash=${hash}&expires=${expires}`,
    { Referer: `${SITE}/movies/play/${slug}`, "X-Requested-With": "XMLHttpRequest" },
    20_000,
  );
  if (!out || out.status !== 200) return null;
  try {
    return JSON.parse(out.body) as AccessPayload;
  } catch {
    return null;
  }
}

/**
 * English caption candidates for one episode — used by the harvest script's
 * inline copy (scripts can't import TS): kept here as the source of truth
 * for the access -> subtitles contract. Returns absolute VTT URLs valid for
 * THIS access call (session-bound, download immediately).
 */
export function englishVttUrls(payload: AccessPayload): string[] {
  const out: string[] = [];
  for (const s of payload.subtitles ?? []) {
    if (!/english/i.test(s.language ?? "") || !s.file) continue;
    out.push(s.file.startsWith("http") ? s.file : `${SITE}${s.file}`);
  }
  return out;
}
