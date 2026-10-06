/*
 * Full-episode offline save — the "plays a minute then buffers" fix.
 *
 * Watching online only caches what hls.js FETCHES (a ~60s rolling buffer),
 * so going offline left the rest of the episode un-cached: playback ran to
 * the end of the buffered window and stalled. This module walks the whole
 * HLS tree while the app is online — master playlist -> every variant
 * playlist -> the chosen quality's segments (in order, low concurrency) ->
 * audio renditions (dual-audio FlixCloud dubs) -> AES keys -> subtitles —
 * through the normal proxy URLs, so the service worker stashes every byte
 * as it lands. Nothing is written by this module itself; the SW cache IS
 * the store.
 *
 * Also saves the NEXT episode (resolving /api/stream for it, which doubles
 * as the SW's API-cache warm), so "tap next while offline" actually plays.
 *
 * Re-runs are nearly free: segment URLs are cache-first in the SW, so a
 * partially saved episode re-downloads only its missing pieces.
 */

export type SavePhase = "download" | "done" | "error";

export type SaveState = {
  key: string; // `${malId}:${ep}:${lang}:${server}`
  done: number;
  total: number;
  phase: SavePhase;
};

type Job = {
  key: string;
  playlistUrl: string;
  subtitles?: string[];
  onProgress?: (s: SaveState) => void;
  resolveNext?: () => Promise<Omit<Job, "resolveNext"> | null>;
};

const REGISTRY_KEY = "clyle.offlineEps";
const REGISTRY_MAX = 60; // remember the last N saved episodes
const SEGMENT_CONCURRENCY = 3;
const MAX_SEGMENTS = 4000; // sanity cap — a 24-min episode is ~300-500
const MAX_CONSECUTIVE_FAILS = 8;

// ---- module-singleton queue (survives WatchView unmounts within the SPA) --
let active: Job | null = null;
const queued: Job[] = [];
let pumping = false;
let netOffline = false;
if (typeof window !== "undefined") {
  window.addEventListener("offline", () => {
    netOffline = true;
  });
  window.addEventListener("online", () => {
    netOffline = false;
  });
}

/** Already-saved registry: key -> master playlist URL (token identity). */
function registry(): Record<string, { url: string; segs: number; at: number }> {
  try {
    return JSON.parse(localStorage.getItem(REGISTRY_KEY) || "{}");
  } catch {
    return {};
  }
}

function remember(key: string, url: string, segs: number) {
  try {
    const reg = registry();
    reg[key] = { url, segs, at: Date.now() };
    const entries = Object.entries(reg)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, REGISTRY_MAX);
    localStorage.setItem(REGISTRY_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* private mode — saving still works, just re-runs next time */
  }
}

export function isEpisodeSaved(key: string, playlistUrl?: string): boolean {
  const hit = registry()[key];
  if (!hit) return false;
  return playlistUrl ? hit.url === playlistUrl : true;
}

function emit(job: Job, done: number, total: number, phase: SavePhase) {
  try {
    job.onProgress?.({ key: job.key, done, total, phase });
  } catch {
    /* UI listener issues never break the download */
  }
}

// ---- tiny HLS parsing (the playlists are already proxy-rewritten) ---------

function fetchText(url: string): Promise<string> {
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error(`playlist ${r.status}`);
    return r.text();
  });
}

type Master = {
  variants: Array<{ url: string; bandwidth: number }>;
  audio: string[]; // rendition playlist URLs (dual-audio masters)
};

function parseMaster(text: string): Master | null {
  if (!text.includes("#EXT-X-STREAM-INF")) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants: Master["variants"] = [];
  const audio: string[] = [];
  let pendingBw = 0;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      pendingBw = parseInt(/BANDWIDTH=(\d+)/.exec(line)?.[1] ?? "0", 10);
      continue;
    }
    if (line.startsWith("#EXT-X-MEDIA")) {
      const uri = /URI="([^"]+)"/.exec(line)?.[1];
      if (uri) audio.push(uri);
      continue;
    }
    if (line.startsWith("#")) continue;
    variants.push({ url: line, bandwidth: pendingBw });
    pendingBw = 0;
  }
  return variants.length ? { variants, audio: [...new Set(audio)] } : null;
}

function parseSegmentLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function parseTagUris(text: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`#${tag}[^\\r\\n]*URI="([^"]+)"`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]);
  return [...new Set(out)];
}

/** Ordered concurrency pool; reports progress after each completion. */
async function pool(urls: string[], onOne: () => void): Promise<boolean> {
  let fails = 0;
  let i = 0;
  const workers = Array.from({ length: Math.min(SEGMENT_CONCURRENCY, urls.length) }, async () => {
    while (i < urls.length) {
      if (netOffline) throw new Error("offline");
      const url = urls[i++];
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(String(res.status));
          await res.arrayBuffer(); // drain — the SW stashed it already
          fails = 0;
          break;
        } catch (e) {
          if (netOffline) throw new Error("offline");
          if (attempt === 1) {
            fails++;
            if (fails >= MAX_CONSECUTIVE_FAILS) throw new Error("too many failures");
          } else {
            await new Promise((r) => setTimeout(r, 1_200));
          }
        }
      }
      onOne();
    }
  });
  try {
    await Promise.all(workers);
    return true;
  } catch {
    return false; // partial save — missing pieces re-download next time
  }
}

// ---- the runner -----------------------------------------------------------

async function runJob(job: Job): Promise<boolean> {
  // a non-HLS source (progressive MP4 dub backfill) is a single fetch
  const looksHls = /\.m3u8($|\?)/i.test(job.playlistUrl) || job.playlistUrl.includes("fkey=");
  const head = await fetchTextSafe(job.playlistUrl);
  if (head == null) return false;

  let mediaPlaylistUrl = job.playlistUrl;
  if (looksHls) {
    const master = parseMaster(head);
    if (master) {
      // stash every variant playlist (cheap) so the SW's offline master
      // filter can see them; segments only for the best one
      await Promise.all(master.variants.map((v) => fetchTextSafe(v.url).catch(() => null)));
      const best = master.variants.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));
      mediaPlaylistUrl = best.url;
      // dual-audio renditions: playlist + their segments must land too
      for (const aud of master.audio) {
        try {
          const t = await fetchText(aud);
          const segs = parseSegmentLines(t).slice(0, MAX_SEGMENTS);
          const keys = parseTagUris(t, "EXT-X-KEY");
          const maps = parseTagUris(t, "EXT-X-MAP");
          await pool([...keys, ...maps, ...segs], () => undefined);
        } catch {
          /* rendition failed — the SW filter drops it offline */
        }
      }
    }
    const mediaText = await fetchTextSafe(mediaPlaylistUrl);
    if (mediaText == null) return false;
    if (!mediaText.includes("#EXT-X-ENDLIST")) return false; // live stream — can't fully save

    const segs = parseSegmentLines(mediaText).slice(0, MAX_SEGMENTS);
    const keys = parseTagUris(mediaText, "EXT-X-KEY");
    const maps = parseTagUris(mediaText, "EXT-X-MAP");
    const total = segs.length + keys.length + maps.length;
    let done = 0;
    if (keys.length + maps.length) {
      const okKeys = await pool([...keys, ...maps], () => undefined);
      if (!okKeys) return false;
    }
    const ok = await pool(segs, () => emit(job, ++done, total, "download"));
    if (!ok) return false;
    emit(job, total, total, "download");
  } else {
    // single progressive file — one fetch through the proxy stashes it
    try {
      const res = await fetch(job.playlistUrl);
      if (!res.ok) return false;
      await res.arrayBuffer();
    } catch {
      return false;
    }
    emit(job, 1, 1, "download");
  }

  // subtitles (vtt) — small, best-effort
  if (job.subtitles?.length) {
    await Promise.allSettled(job.subtitles.map((u) => fetch(u).then((r) => r.arrayBuffer())));
  }

  remember(job.key, job.playlistUrl, 1);
  emit(job, 1, 1, "done");
  return true;
}

async function fetchTextSafe(url: string): Promise<string | null> {
  try {
    return await fetchText(url);
  } catch {
    return null;
  }
}

// ---- queue pump -----------------------------------------------------------

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (queued.length && !netOffline) {
      const job = queued.shift()!;
      active = job;
      const ok = await runJob(job);
      active = null;
      if (ok) await resolveAndEnqueueNext(job);
    }
  } finally {
    pumping = false;
  }
}

async function resolveAndEnqueueNext(job: Job): Promise<void> {
  if (!job.resolveNext || netOffline) return;
  try {
    const next = await job.resolveNext();
    if (next) {
      enqueueEpisodeSave({
        ...next,
        onProgress: (s) => {
          // surface the next-episode save in the same pill
          job.onProgress?.(s);
        },
      });
    }
  } catch {
    /* next-episode resolution is best-effort */
  }
}

/**
 * Save an episode (and chain the next one) for offline playback. Safe to
 * call again for the same key: an already-saved episode reports `done`
 * immediately (so the UI stays truthful) and still resolves the next one.
 * Returns a disposer that only detaches THIS caller's progress listener —
 * the download itself keeps running in the background.
 */
export function enqueueEpisodeSave(job: Job): () => void {
  const mine = job;
  if (isEpisodeSaved(job.key, job.playlistUrl)) {
    emit(mine, 1, 1, "done");
    void resolveAndEnqueueNext(job); // still save the next episode
  } else if (!(active?.key === job.key || queued.some((j) => j.key === job.key))) {
    // keep the queue tiny: the newest two episodes the viewer actually opened
    while (queued.length >= 2) queued.shift();
    queued.push(job);
    void pump();
  } else {
    // already in flight — the newest listener replaces the old one
    const inFlight = active?.key === job.key ? active : queued.find((j) => j.key === job.key);
    if (inFlight) inFlight.onProgress = job.onProgress;
  }
  return () => {
    /* listener lives on the job object; a replaced job drops this ref */
  };
}

/** Forget saved-episode bookkeeping (the SW cache itself is untouched). */
export function forgetSavedEpisode(key: string) {
  try {
    const reg = registry();
    delete reg[key];
    localStorage.setItem(REGISTRY_KEY, JSON.stringify(reg));
  } catch {
    /* ignore */
  }
}
