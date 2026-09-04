"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { AnimeLite, ContinueItem } from "@/lib/types";
import { getUserId } from "@/lib/profile-store";

/* ---------------- My List (favorites) ---------------- */

const MYLIST_KEY = "animetest123.mylist";
const PROGRESS_KEY = "animetest123.progress";

interface MyListEntry {
  malId: number;
  title: string;
  image: string | null;
  addedAt: number;
}

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full/blocked — ignore */
  }
}

const MYLIST_EVENT = "mylist-changed";

function subscribeMyList(onChange: () => void) {
  window.addEventListener(MYLIST_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(MYLIST_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function getMyListSnapshot(): string {
  return window.localStorage.getItem(MYLIST_KEY) ?? "[]";
}

function getMyListServerSnapshot(): string {
  return "[]";
}

export function useMyList() {
  const raw = useSyncExternalStore(subscribeMyList, getMyListSnapshot, getMyListServerSnapshot);

  const list: MyListEntry[] = (() => {
    try {
      return JSON.parse(raw) as MyListEntry[];
    } catch {
      return [];
    }
  })();

  const has = useCallback((malId: number) => list.some((e) => e.malId === malId), [list]);

  const toggle = useCallback((anime: Pick<AnimeLite, "malId" | "title" | "image">) => {
    const current = (() => {
      try {
        return JSON.parse(window.localStorage.getItem(MYLIST_KEY) ?? "[]") as MyListEntry[];
      } catch {
        return [] as MyListEntry[];
      }
    })();
    const exists = current.some((e) => e.malId === anime.malId);
    const next = exists
      ? current.filter((e) => e.malId !== anime.malId)
      : [{ malId: anime.malId, title: anime.title, image: anime.image, addedAt: Date.now() }, ...current];
    writeJson(MYLIST_KEY, next);
    try {
      window.dispatchEvent(new CustomEvent(MYLIST_EVENT));
    } catch {
      /* ignore */
    }
  }, []);

  const malIds = list.map((e) => e.malId);
  return { list, malIds, has, toggle, ready: true };
}

/* ---------------- Watch progress ---------------- */

export interface Progress {
  ep: number;
  lang: "sub" | "dub";
  updatedAt: number;
}

export function getProgressMap(): Record<string, Progress> {
  return readJson<Record<string, Progress>>(PROGRESS_KEY, {});
}

export function getProgress(malId: number): Progress | null {
  return getProgressMap()[String(malId)] ?? null;
}

export function setProgress(malId: number, ep: number, lang: "sub" | "dub") {
  const map = getProgressMap();
  map[String(malId)] = { ep, lang, updatedAt: Date.now() };
  writeJson(PROGRESS_KEY, map);
  try {
    window.dispatchEvent(new CustomEvent("progress-changed"));
  } catch {
    /* ignore */
  }
}

export function useProgressVersion() {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const onChange = () => setVersion((v) => v + 1);
    window.addEventListener("progress-changed", onChange);
    return () => window.removeEventListener("progress-changed", onChange);
  }, []);
  return version;
}

/* ---------------- Detailed per-episode progress ---------------- *
 *
 * Precise resume points: seconds watched out of total seconds, for EVERY
 * episode (not just the latest one). Written by the player heartbeat, shown
 * as the red bars under the episode buttons and the Continue Watching row.
 * Saved to localStorage (instant, offline-safe) and mirrored to the server
 * (cross-device + survives storage clears) — both are best-effort.
 */

const EP_PROGRESS_KEY = "animetest123.epprogress";

export interface DetailedProgress {
  pos: number; // seconds watched
  dur: number; // total seconds
  completed: boolean;
  lang: "sub" | "dub";
  server: string;
  title?: string;
  image?: string | null;
  total?: number; // anime total episodes (snapshot)
  updatedAt: number;
}

type EpisodeProgressMap = Record<string, Record<string, DetailedProgress>>;

function readEpMap(): EpisodeProgressMap {
  return readJson<EpisodeProgressMap>(EP_PROGRESS_KEY, {});
}

/** All saved episode progress for one anime, keyed by episode number. */
export function getEpProgressAll(malId: number): Record<string, DetailedProgress> {
  return readEpMap()[String(malId)] ?? {};
}

/** Saved progress for one episode (null when we have nothing). */
export function getEpProgress(malId: number, episode: number): DetailedProgress | null {
  return readEpMap()[String(malId)]?.[String(episode)] ?? null;
}

export interface SaveProgressArgs {
  malId: number;
  episode: number;
  lang: "sub" | "dub";
  server: string;
  position: number;
  duration: number;
  completed?: boolean;
  title?: string;
  image?: string | null;
  total?: number;
}

/**
 * Persist progress locally immediately; mirror to the server. When
 * `keepalive` is set (page unload / tab hide) the request is sent with
 * keepalive so it survives navigation.
 */
export function saveProgressDetailed(args: SaveProgressArgs, opts?: { keepalive?: boolean }) {
  if (!Number.isFinite(args.position) || args.position < 5) return;
  // removed from Continue Watching — stale saves (heartbeats, beacons, the
  // unmount flush of a just-left player) must not resurrect it. The only
  // way back in is a deliberate watch (clearProgressTombstone on mount).
  if (isProgressRemoved(args.malId)) return;
  const completed = args.completed ?? (args.duration > 0 && args.position >= args.duration * 0.92);
  const entry: DetailedProgress = {
    pos: Math.floor(args.position),
    dur: Math.floor(args.duration || 0),
    completed,
    lang: args.lang,
    server: args.server,
    title: args.title,
    image: args.image,
    total: args.total,
    updatedAt: Date.now(),
  };

  // local (instant — bars/resume render without a round trip)
  const map = readEpMap();
  const key = String(args.malId);
  map[key] = map[key] ?? {};
  map[key][String(args.episode)] = entry;
  writeJson(EP_PROGRESS_KEY, map);

  // legacy "last watched episode" map (details badge, resume fallback)
  try {
    const legacy = JSON.parse(window.localStorage.getItem(PROGRESS_KEY) ?? "{}");
    legacy[key] = { ep: args.episode, lang: args.lang, pos: entry.pos, updatedAt: entry.updatedAt };
    window.localStorage.setItem(PROGRESS_KEY, JSON.stringify(legacy));
  } catch {
    /* ignore */
  }

  try {
    window.dispatchEvent(new CustomEvent("progress-changed"));
  } catch {
    /* ignore */
  }

  // server mirror (best effort, never blocks playback)
  const userId = getUserId();
  const body = JSON.stringify({
    userId,
    malId: args.malId,
    episode: args.episode,
    lang: args.lang,
    server: args.server,
    position: entry.pos,
    duration: entry.dur,
    completed,
    title: args.title,
    image: args.image,
  });
  try {
    if (opts?.keepalive && "sendBeacon" in navigator) {
      navigator.sendBeacon("/api/progress", new Blob([body], { type: "application/json" }));
    } else {
      fetch("/api/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        ...(opts?.keepalive ? { keepalive: true } : {}),
      }).catch(() => undefined);
    }
  } catch {
    /* ignore */
  }
}

/** Forget everything watched for one anime (Continue Watching "X" button). */
export function removeProgress(malId: number) {
  // tombstone FIRST — an in-flight save must not re-add this anime between
  // here and the server DELETE ("deleted it but it came back" bug)
  markProgressRemoved(malId);
  const map = readEpMap();
  delete map[String(malId)];
  writeJson(EP_PROGRESS_KEY, map);
  removeEpThumbs(malId);
  try {
    const legacy = JSON.parse(window.localStorage.getItem(PROGRESS_KEY) ?? "{}");
    delete legacy[String(malId)];
    window.localStorage.setItem(PROGRESS_KEY, JSON.stringify(legacy));
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(new CustomEvent("progress-changed"));
  } catch {
    /* ignore */
  }
  // keepalive so the removal survives the tab closing mid-request; the
  // server tombstones the removal too (blocks late beacon/heartbeat saves).
  // Retried twice — a lost DELETE (subway dead zone, app killed mid-flight)
  // used to leave the server row alive and the card resurrected on the next
  // Home visit; the retries close most of that window.
  const userId = getUserId();
  const del = (attempt: number): void => {
    try {
      fetch(`/api/progress?userId=${encodeURIComponent(userId)}&malId=${malId}`, {
        method: "DELETE",
        keepalive: true,
      }).catch(() => {
        if (attempt < 2) window.setTimeout(() => del(attempt + 1), 2_500 * (attempt + 1));
      });
    } catch {
      if (attempt < 2) window.setTimeout(() => del(attempt + 1), 2_500 * (attempt + 1));
    }
  };
  del(0);
}

/**
 * Reconciliation for the "deleted it but it came back" bug: re-fire the
 * server DELETE for every anime this device has tombstoned in the last 48h.
 * A removal whose DELETE request was lost (offline moment, app killed) gets
 * healed the next time the Home rail loads; the local tombstone keeps the
 * card hidden in the meantime. Idempotent — the server DELETE just deletes
 * (and re-stamps) again.
 */
export function sweepRemovedProgress(): void {
  const map = readRemovedMap();
  const cutoff = Date.now() - 48 * 3600_000;
  const fresh = Object.entries(map).filter(([, at]) => at >= cutoff);
  if (!fresh.length) return;
  const userId = getUserId();
  for (const [malId, at] of fresh) {
    const id = Number(malId);
    if (!Number.isFinite(id)) continue;
    // pace slightly: these are keepalive DELETEs, tiny and idempotent
    window.setTimeout(() => {
      try {
        fetch(`/api/progress?userId=${encodeURIComponent(userId)}&malId=${id}`, {
          method: "DELETE",
          keepalive: true,
        }).catch(() => undefined);
      } catch {
        /* best-effort */
      }
      void at;
    }, 150 + Math.random() * 400);
  }
}

/* ---------------- removal tombstones (local half) ----------------
 * The server rejects saves for removed anime (RemovedProgress table), but
 * the local map must obey too: a save that raced the delete would otherwise
 * re-add bars/Continue entries the moment the server list is merged. */

const REMOVED_KEY = "animetest123.progress-removed";

function readRemovedMap(): Record<string, number> {
  return readJson<Record<string, number>>(REMOVED_KEY, {});
}

function markProgressRemoved(malId: number) {
  const map = readRemovedMap();
  map[String(malId)] = Date.now();
  writeJson(REMOVED_KEY, map);
}

function isProgressRemoved(malId: number): boolean {
  return Boolean(readRemovedMap()[String(malId)]);
}

/**
 * Deliberate playback (WatchView mounted for this anime) — lift the removal
 * tombstone locally + on the server so progress tracking resumes.
 */
export function clearProgressTombstone(malId: number) {
  if (!isProgressRemoved(malId)) return;
  const map = readRemovedMap();
  delete map[String(malId)];
  writeJson(REMOVED_KEY, map);
  try {
    fetch("/api/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: getUserId(), malId, resume: true }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* ignore */
  }
}

/**
 * Server-side progress for one anime — used as a fallback so resume points
 * and red bars survive cleared storage / a fresh browser.
 */
export async function fetchServerProgress(malId: number): Promise<Record<string, DetailedProgress>> {
  try {
    const res = await fetch(`/api/progress?userId=${encodeURIComponent(getUserId())}&malId=${malId}`);
    if (!res.ok) return {};
    const data = (await res.json()) as {
      episodes: Array<{ episode: number; position: number; duration: number; completed: boolean; lang: string; server: string }>;
    };
    const out: Record<string, DetailedProgress> = {};
    for (const e of data.episodes ?? []) {
      out[String(e.episode)] = {
        pos: e.position,
        dur: e.duration,
        completed: e.completed,
        lang: e.lang === "dub" ? "dub" : "sub",
        server: e.server,
        updatedAt: Date.now(),
      };
    }
    // merge into the local map (server rows are authoritative for these keys)
    if (Object.keys(out).length) {
      const map = readEpMap();
      const key = String(malId);
      map[key] = { ...(map[key] ?? {}), ...out };
      writeJson(EP_PROGRESS_KEY, map);
    }
    return out;
  } catch {
    return {};
  }
}

/* ---------------- Continue Watching ---------------- */

/**
 * Freshest in-progress episode per anime — server list merged with the
 * instant local map (so the rail renders with zero latency and still shows
 * entries when the server DB is cold).
 */
export function mergeContinueItems(serverItems: ContinueItem[]): ContinueItem[] {
  let localAll: Record<string, Record<string, DetailedProgress>> = {};
  try {
    localAll = JSON.parse(window.localStorage.getItem(EP_PROGRESS_KEY) ?? "{}");
  } catch {
    localAll = {};
  }
  // the local removal tombstone is the user's expressed intent: a server row
  // that slipped through the delete race (lost DELETE request, beacon that
  // landed a heartbeat ahead of it on another lambda) must not resurrect the
  // card in the UI. Deliberate playback lifts the tombstone (both halves).
  const removed = readRemovedMap();

  type Row = { item: ContinueItem; at: number };
  const byAnime = new Map<number, Row>();

  for (const it of serverItems) {
    if (it.completed) continue;
    if (removed[String(it.malId)]) continue; // deleted here — stays deleted
    byAnime.set(it.malId, { item: it, at: Date.parse(it.updatedAt) });
  }

  for (const [malId, eps] of Object.entries(localAll)) {
    // removed from Continue Watching — a save that raced the delete must not
    // re-add the entry here either
    if (readRemovedMap()[malId]) continue;
    for (const [ep, e] of Object.entries(eps)) {
      if (e.completed || (e.pos || 0) < 5) continue;
      const malIdNum = Number(malId);
      const prev = byAnime.get(malIdNum);
      if (prev && prev.at >= e.updatedAt) continue;
      const percent = e.dur > 0 ? Math.min(100, Math.round((e.pos / e.dur) * 100)) : 0;
      byAnime.set(malIdNum, {
        at: e.updatedAt,
        item: {
          malId: malIdNum,
          title: e.title ?? prev?.item.title ?? "Unknown title",
          image: e.image ?? prev?.item.image ?? null,
          banner: prev?.item.banner ?? null,
          totalEpisodes: e.total ?? prev?.item.totalEpisodes ?? 0,
          type: prev?.item.type ?? null,
          episode: Number(ep),
          lang: e.lang,
          server: e.server,
          position: e.pos,
          duration: e.dur,
          percent,
          completed: false,
          updatedAt: new Date(e.updatedAt).toISOString(),
        },
      });
    }
  }

  return [...byAnime.values()].sort((a, b) => b.at - a.at).map((r) => r.item);
}

/** GET /api/continue merged with local progress. */
export async function loadContinueItems(): Promise<ContinueItem[]> {
  let serverItems: ContinueItem[] = [];
  try {
    const res = await fetch(`/api/continue?userId=${encodeURIComponent(getUserId())}`);
    if (res.ok) {
      const data = (await res.json()) as { items: ContinueItem[] };
      serverItems = data.items ?? [];
    }
  } catch {
    /* offline / cold server — local only */
  }
  return mergeContinueItems(serverItems);
}

/* ---------------- Episode scene thumbnails ---------------- *
 *
 * Crunchyroll-style Continue Watching art: while an episode plays we grab a
 * frame straight off the <video> surface (canvas -> JPEG data URL) and keep
 * it per episode+lang. Streams play through our own same-origin proxy via
 * MSE, so the canvas is never tainted and the capture virtually always
 * succeeds; anything that fails just falls back to the poster art.
 *
 * Each episode captures ONCE (the first session it is watched — that frame
 * is the "random scene"); stored thumbs are evicted LRU-style so the
 * localStorage budget stays bounded.
 */

const EP_THUMBS_KEY = "animetest123.epthumbs";
const EP_THUMBS_MAX = 80; // ~10-14KB each at 224x126 q0.62 -> well under quota

type ThumbEntry = { t: string; at: number };
type ThumbMap = Record<string, Record<string, ThumbEntry>>;

function readThumbs(): ThumbMap {
  return readJson<ThumbMap>(EP_THUMBS_KEY, {});
}

function writeThumbs(map: ThumbMap) {
  // global LRU cap — evict the oldest captures first
  const all: Array<{ malId: string; ep: string; at: number }> = [];
  for (const [malId, eps] of Object.entries(map)) {
    for (const [ep, entry] of Object.entries(eps)) all.push({ malId, ep, at: entry.at });
  }
  if (all.length > EP_THUMBS_MAX) {
    all.sort((a, b) => a.at - b.at);
    for (const victim of all.slice(0, all.length - EP_THUMBS_MAX)) delete map[victim.malId][victim.ep];
  }
  writeJson(EP_THUMBS_KEY, map);
}

/** Stored scene thumbnail for one episode (null when we have none yet). */
export function getEpThumb(malId: number, episode: number, lang: "sub" | "dub"): string | null {
  const entry = readThumbs()[String(malId)]?.[`${episode}:${lang}`];
  return entry?.t ?? null;
}

/** Persist a captured frame. First capture wins; later sessions keep it. */
export function saveEpThumb(malId: number, episode: number, lang: "sub" | "dub", dataUrl: string) {
  try {
    const map = readThumbs();
    const key = String(malId);
    const epKey = `${episode}:${lang}`;
    if (map[key]?.[epKey]) return; // keep the original "random scene"
    map[key] = map[key] ?? {};
    map[key][epKey] = { t: dataUrl, at: Date.now() };
    writeThumbs(map);
    try {
      window.dispatchEvent(new CustomEvent("epthumbs-changed"));
    } catch {
      /* ignore */
    }
  } catch {
    /* quota / private mode — thumbnails are decorative, never fatal */
  }
}

export function removeEpThumbs(malId: number) {
  try {
    const map = readThumbs();
    delete map[String(malId)];
    writeJson(EP_THUMBS_KEY, map);
  } catch {
    /* ignore */
  }
}

/* ---------------- Watch time (Top 10 Today) ---------------- *
 *
 * "Top 10 Today" ranks anime by how long people ACTUALLY watch them — the
 * rail stays empty until real playback seconds exist. The player records
 * wall-clock deltas while the video is playing; they accumulate locally
 * (instant, offline-safe) and flush to the server so EVERY viewer's time
 * lands in one global per-day ranking, Crunchyroll-style.
 *
 * Local shape: day -> malId -> { seconds, title, image, sent }.
 * `sent` is the amount already ACKed by the server, so flushes POST only
 * the un-sent remainder. Display merges server + local with max() — never
 * a sum — so nothing is double-counted and offline time still shows.
 */

const WATCHTIME_KEY = "animetest123.watchtime";
const WATCHTIME_EVENT = "watchtime-changed";
const WATCHTIME_KEEP_DAYS = 7; // local buckets older than a week are dropped

export interface LocalWatchEntry {
  seconds: number;
  title?: string;
  image?: string | null;
  sent?: number; // seconds already accepted by the server
}

type WatchTimeMap = Record<string, Record<string, LocalWatchEntry>>;

/**
 * The SHARED calendar day ("YYYY-MM-DD", UTC) — one global bucket, so every
 * device in every timezone contributes to (and sees) the exact same
 * "Top 10 Today" ranking, like Netflix's worldwide lists. Rolls over at
 * UTC midnight for everyone.
 */
export function localDayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function readWatchTime(): WatchTimeMap {
  return readJson<WatchTimeMap>(WATCHTIME_KEY, {});
}

function writeWatchTime(map: WatchTimeMap) {
  // prune: keep only the newest KEEP_DAYS day buckets
  const days = Object.keys(map).sort();
  for (const stale of days.slice(0, Math.max(0, days.length - WATCHTIME_KEEP_DAYS))) delete map[stale];
  writeJson(WATCHTIME_KEY, map);
}

/**
 * Add `delta` seconds of real playback to today's bucket for this anime and
 * flush the un-sent remainder to the server (best effort, never throws).
 * `keepalive` switches to sendBeacon for pagehide/unload flushes.
 */
export function recordWatchSeconds(
  args: { malId: number; title?: string; image?: string | null; delta: number; day?: string },
  opts?: { keepalive?: boolean },
) {
  const delta = Math.min(120, Math.max(0, Number(args.delta) || 0));
  if (delta < 1 || !Number.isFinite(args.malId)) return;
  const day = args.day ?? localDayKey(); // shared UTC day — one global ranking

  let pending = 0;
  try {
    const map = readWatchTime();
    const dayBucket = (map[day] = map[day] ?? {});
    const entry = dayBucket[String(args.malId)] ?? { seconds: 0, sent: 0 };
    entry.seconds += delta;
    if (args.title) entry.title = args.title;
    if (args.image !== undefined) entry.image = args.image;
    dayBucket[String(args.malId)] = entry;
    pending = entry.seconds - (entry.sent ?? 0);
    if (pending >= 5) {
      entry.sent = entry.seconds; // optimistic — reverted below if the send fails outright
      writeWatchTime(map);
    } else {
      pending = 0;
      writeWatchTime(map);
    }
  } catch {
    return; // storage blocked — ranking is decorative, never fatal
  }

  if (pending < 5) {
    // still notify listeners so Home can re-rank from the local bucket alone
    try {
      window.dispatchEvent(new CustomEvent(WATCHTIME_EVENT));
    } catch {
      /* ignore */
    }
    return;
  }

  const body = JSON.stringify({
    userId: getUserId(),
    malId: args.malId,
    day,
    delta: Math.round(pending),
    title: args.title,
    image: args.image,
  });
  const revert = () => {
    try {
      const map = readWatchTime();
      const entry = map[day]?.[String(args.malId)];
      if (entry) {
        entry.sent = Math.max(0, (entry.sent ?? 0) - pending);
        writeWatchTime(map);
      }
    } catch {
      /* ignore */
    }
  };
  try {
    if (opts?.keepalive && "sendBeacon" in navigator) {
      navigator.sendBeacon("/api/watchtime", new Blob([body], { type: "application/json" }));
    } else {
      fetch("/api/watchtime", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      })
        .then((res) => {
          if (!res.ok) revert(); // server rejected — retry on a later tick
        })
        .catch(revert);
    }
  } catch {
    revert();
  }

  try {
    window.dispatchEvent(new CustomEvent(WATCHTIME_EVENT));
  } catch {
    /* ignore */
  }
}

/** Subscribe to watch-time changes (local accrual + cross-tab). */
export function subscribeWatchTime(onChange: () => void) {
  window.addEventListener(WATCHTIME_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(WATCHTIME_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export type TopWatchEntry = AnimeLite & {
  seconds: number;
  streakDays?: number; // consecutive days in the Top 10 (server-computed)
  isNew?: boolean; // first day of the current streak
  weeksInTop10?: number; // Math.floor(streakDays / 7)
};

/** One row of the "Top 10 This Month" rail (TMDB-popularity ranking). */
export type Top10MonthEntry = AnimeLite & {
  rank: number;
  /** rank before the most recent refresh (null = new in the Top 10) */
  prevRank: number | null;
};

/** The server's active Top 10 This Month (TMDB popularity order). */
export async function fetchTop10Month(): Promise<Top10MonthEntry[]> {
  try {
    const res = await fetch("/api/top10");
    if (!res.ok) return [];
    const data = (await res.json()) as { items?: Top10MonthEntry[] };
    return (data.items ?? []).filter((it) => Number.isFinite(it?.malId));
  } catch {
    return [];
  }
}

/** Minimal stand-in when only a server event/snapshot knows this anime. */
export function minimalLite(malId: number, title: string, image: string | null): AnimeLite {
  return {
    malId,
    title,
    titleEnglish: null,
    image,
    banner: null,
    logo: null,
    synopsis: null,
    type: null,
    ratingShort: null,
    status: null,
    airing: false,
    season: null,
    year: null,
    durationMin: null,
    score: null,
    rank: null,
    popularity: null,
    totalEpisodes: 0,
    genres: [],
    inCatalog: true,
    source: "local",
  };
}

/**
 * The day's most-watched anime: the server's global ranking merged with this
 * device's instant local buckets (max, not sum — no double counting; local
 * covers the un-flushed tail and offline/served-cold cases).
 */
export async function fetchWatchTimeTop(day: string, limit = 10): Promise<TopWatchEntry[]> {
  let serverItems: TopWatchEntry[] = [];
  try {
    const res = await fetch(`/api/watchtime?day=${encodeURIComponent(day)}&limit=${limit}`);
    if (res.ok) {
      const data = (await res.json()) as { items?: TopWatchEntry[] };
      serverItems = data.items ?? [];
    }
  } catch {
    /* offline / cold server — local buckets only */
  }

  const byId = new Map<number, TopWatchEntry>();
  for (const it of serverItems) {
    if (Number.isFinite(it?.malId)) byId.set(it.malId, it);
  }
  try {
    const local = readWatchTime()[day] ?? {};
    for (const [key, entry] of Object.entries(local)) {
      const malId = Number(key);
      if (!Number.isFinite(malId)) continue;
      const prev = byId.get(malId);
      const seconds = Math.max(prev?.seconds ?? 0, entry.seconds || 0);
      if (seconds < 5) continue; // a stray couple of seconds isn't "watched"
      byId.set(malId, {
        ...(prev ?? minimalLite(malId, entry.title || `Anime ${malId}`, entry.image ?? null)),
        // local snapshots keep the rail informative when the catalog row is gone
        title: prev?.title || entry.title || `Anime ${malId}`,
        image: prev?.image ?? entry.image ?? null,
        malId,
        seconds,
      });
    }
  } catch {
    /* ignore */
  }

  return [...byId.values()].sort((a, b) => b.seconds - a.seconds).slice(0, limit);
}

/* ---------------- language / server preference ---------------- */

const LANGPREF_KEY = "animetest123.langpref";

export interface LangPref {
  lang: "sub" | "dub";
  server: "zoko" | "kiwi";
}

interface LangPrefStore {
  global?: LangPref;
  byAnime?: Record<string, LangPref>;
}

function readLangPref(): LangPrefStore {
  return readJson<LangPrefStore>(LANGPREF_KEY, {});
}

/**
 * What this viewer last watched (per anime, falling back to their global
 * last choice) — the episode-list server sheet leads with it so pressing
 * back and picking the next episode keeps you in DUB when you were in DUB.
 */
export function getLangPref(malId?: number): LangPref {
  try {
    const store = readLangPref();
    const perAnime = malId != null ? store.byAnime?.[String(malId)] : undefined;
    return perAnime ?? store.global ?? { lang: "sub", server: "zoko" };
  } catch {
    return { lang: "sub", server: "zoko" };
  }
}

export function setLangPref(malId: number | null, pref: LangPref) {
  try {
    const store = readLangPref();
    store.global = pref;
    if (malId != null) {
      store.byAnime = store.byAnime ?? {};
      store.byAnime[String(malId)] = pref;
    }
    writeJson(LANGPREF_KEY, store);
  } catch {
    /* storage blocked — cosmetic preference only */
  }
}

/* ---------------- Top 10 notifications (bell) ---------------- */

const TOP10_READ_KEY = "animetest123.top10read";
const TOP10_READ_EVENT = "top10read-changed";

export interface Top10EventItem {
  id: number;
  type: "enter" | "leave" | "up" | "down";
  malId: number;
  day: string;
  title: string;
  image: string | null;
  rank: number | null;
  prevRank?: number | null; // rank before the change (up/down/leave)
  weeks?: number | null; // legacy (watch-time era leaves): full weeks it was up
  createdAt: string;
}

/** The server's Top 10 rank-change feed (same for every viewer). */
export async function fetchTop10Events(): Promise<Top10EventItem[]> {
  const res = await fetch("/api/top10-events");
  if (!res.ok) throw new Error(String(res.status));
  const data = (await res.json()) as { events?: Top10EventItem[] };
  return Array.isArray(data.events) ? data.events : [];
}

/** Per-device read watermark: every event with a bigger id is unread. */
export function getTop10ReadId(): number {
  return readJson<{ id?: number }>(TOP10_READ_KEY, {}).id ?? 0;
}

export function markTop10Read(maxId: number) {
  if (!Number.isFinite(maxId) || maxId <= getTop10ReadId()) return;
  writeJson(TOP10_READ_KEY, { id: Math.floor(maxId) });
  try {
    window.dispatchEvent(new Event(TOP10_READ_EVENT));
  } catch {
    /* ignore */
  }
}

/** Subscribe to read-watermark changes (this tab + cross-tab storage). */
export function subscribeTop10Read(onChange: () => void) {
  window.addEventListener(TOP10_READ_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(TOP10_READ_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

const getTop10ReadSnapshot = () => String(getTop10ReadId());
const getTop10ReadServerSnapshot = () => "0";

/** Reactive read watermark for the notification bell (0 = nothing read yet). */
export function useTop10ReadId(): number {
  return Number(useSyncExternalStore(subscribeTop10Read, getTop10ReadSnapshot, getTop10ReadServerSnapshot));
}

/* ---------------- misc ---------------- */

export function timeAgo(iso: string | number): string {
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(t).toLocaleDateString();
}
