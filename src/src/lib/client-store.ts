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

/* ---------------- offline outbox (sync when back online) ----------------
 * Every server write the app makes while offline (progress saves, watch
 * time, removal deletes, my-list hydrate) is parked in localStorage under a
 * dedupe key and replayed the moment the connection is back — either by the
 * browser's `online` event or the next time the app opens. Same-key items
 * replace each other (latest position wins), so a whole offline session of
 * heartbeats collapses into one fresh write per episode.
 */

const OUTBOX_KEY = "animetest123.outbox";
const OUTBOX_MAX = 120;

interface OutboxItem {
  k: string; // dedupe key
  url: string;
  method: "POST" | "DELETE";
  body?: string;
  at: number;
}

function readOutbox(): OutboxItem[] {
  return readJson<OutboxItem[]>(OUTBOX_KEY, []);
}

function writeOutbox(items: OutboxItem[]) {
  writeJson(OUTBOX_KEY, items.slice(-OUTBOX_MAX));
}

function queueOutbox(key: string, url: string, method: "POST" | "DELETE", body?: string) {
  try {
    const items = readOutbox().filter((i) => i.k !== key);
    items.push({ k: key, url, method, body, at: Date.now() });
    writeOutbox(items);
  } catch {
    /* ignore */
  }
}

function dequeueOutbox(key: string) {
  try {
    const items = readOutbox();
    if (!items.some((i) => i.k === key)) return;
    writeOutbox(items.filter((i) => i.k !== key));
  } catch {
    /* ignore */
  }
}

/**
 * Send a write request, or park it in the outbox when the network is down.
 * Returns the Response, or null when the item was queued (or the request
 * failed outright and is now queued). `queueFirst` parks the item BEFORE
 * attempting — for must-eventually-land writes (progress deletes) that
 * survive the page dying mid-request.
 */
export function outboxSend(
  key: string,
  url: string,
  method: "POST" | "DELETE",
  body?: string,
  opts?: { queueFirst?: boolean },
): Promise<Response | null> {
  if (opts?.queueFirst) queueOutbox(key, url, method, body);
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    if (!opts?.queueFirst) queueOutbox(key, url, method, body);
    return Promise.resolve(null);
  }
  return fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body,
    ...(opts?.queueFirst ? { keepalive: true } : {}),
  })
    .then((res) => {
      if (res.ok && opts?.queueFirst) dequeueOutbox(key);
      return res;
    })
    .catch(() => {
      if (!opts?.queueFirst) queueOutbox(key, url, method, body);
      return null;
    });
}

let flushingOutbox = false;

/**
 * Replay the outbox in order. Stops at the first failure (still offline /
 * server refusing) so later items don't jump the queue. Dispatches
 * `clyle-synced` (detail = number of synced writes) when anything landed.
 */
export async function flushOutbox(): Promise<number> {
  if (flushingOutbox) return 0;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return 0;
  flushingOutbox = true;
  let synced = 0;
  try {
    let items = readOutbox();
    while (items.length) {
      const item = items[0];
      try {
        const res = await fetch(item.url, {
          method: item.method,
          headers: item.body ? { "Content-Type": "application/json" } : undefined,
          body: item.body,
        });
        if (!res.ok) break; // server refused — retry on a later flush
        items = items.slice(1);
        writeOutbox(items);
        synced++;
      } catch {
        break; // still offline — stop
      }
    }
  } finally {
    flushingOutbox = false;
  }
  if (synced > 0) {
    try {
      window.dispatchEvent(new CustomEvent("clyle-synced", { detail: synced }));
      window.dispatchEvent(new CustomEvent("progress-changed"));
    } catch {
      /* ignore */
    }
  }
  return synced;
}

/** How many writes are waiting to be synced (debug/settings display). */
export function outboxPendingCount(): number {
  return readOutbox().length;
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
      // offline-safe: a failed save parks in the outbox and lands when the
      // connection returns (same dedupe key — the latest position wins)
      void outboxSend(`prog:${args.malId}:${args.episode}:${args.lang}`, "/api/progress", "POST", body);
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
  // queueFirst: the DELETE is parked BEFORE it is attempted, so a lost
  // request (subway dead zone, app killed mid-flight) is replayed by the
  // next flush instead of leaving the server row alive — the old retry
  // loop could never cover "app died before the request fired".
  const userId = getUserId();
  void outboxSend(
    `progd:${malId}`,
    `/api/progress?userId=${encodeURIComponent(userId)}&malId=${malId}`,
    "DELETE",
    undefined,
    { queueFirst: true },
  );
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
    void outboxSend(`tomb:${malId}`, "/api/progress", "POST", JSON.stringify({ userId: getUserId(), malId, resume: true }));
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
      void outboxSend(`wt:${day}:${args.malId}`, "/api/watchtime", "POST", body).then((res) => {
        // null = the delta was parked in the offline outbox — treat as sent
        // (the flush replays it); only a live server rejection reverts
        if (res !== null && !res.ok) revert();
      });
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

/**
 * The server's active Top 10 This Month (Anime Trending ranking order).
 *
 * `fresh` marks an APP OPEN (mount / PWA foreground return): the server
 * answers from its snapshot instantly but schedules a forced live re-check
 * of the Anime Trending chart past its 2h TTL (floored server-side), so the
 * rail re-grounds itself on every open. The plain variant (60s poll) stays
 * TTL-gated and free.
 */
export async function fetchTop10Month(fresh = false): Promise<Top10MonthEntry[] | null> {
  try {
    const res = await fetch("/api/top10" + (fresh ? "?fresh=1" : ""));
    // null on failure — callers keep the previous list instead of blinking a
    // populated rail away on one failed 60s poll ([] means "honestly empty")
    if (!res.ok) return null;
    const data = (await res.json()) as { items?: Top10MonthEntry[] };
    return (data.items ?? []).filter((it) => Number.isFinite(it?.malId));
  } catch {
    return null;
  }
}

/** One row of the "Arriving" rail — a scheduled drop with its Netflix tag. */
export type ArrivingEntry = AnimeLite & {
  /** "series" = NEW SERIES premiere, "movie" = NEW MOVIE, "episode" = EP n */
  kind: "series" | "movie" | "episode";
  /** episode number for kind="episode"; null for premieres */
  episode: number | null;
  /** unix SECONDS (UTC) of the drop; null = date unknown (TBA) */
  airingAt: number | null;
};

/**
 * The server's Arriving list (next 3 weeks of scheduled drops, air-time
 * order). Same fresh-on-open discipline as fetchTop10Month: the server
 * answers from its snapshot instantly and schedules a forced re-check via
 * after(); the plain variant (60s poll) stays TTL-gated and free.
 */
export async function fetchArriving(fresh = false): Promise<ArrivingEntry[] | null> {
  try {
    const res = await fetch("/api/arriving" + (fresh ? "?fresh=1" : ""));
    // null on failure — a transient error must not wipe the loaded rail
    if (!res.ok) return null;
    const data = (await res.json()) as { items?: ArrivingEntry[] };
    return (data.items ?? []).filter((it) => Number.isFinite(it?.malId));
  } catch {
    return null;
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
    nextEpisodeAt: null,
    nextEpisodeNum: null,
    genres: [],
    inCatalog: true,
    source: "local",
  };
}

/**
 * Build a minimal AnimeLite from a Continue Watching item — shared by the
 * resume path (page.tsx) and the CW (i) info button (HomeView). DetailsView
 * re-enriches from the API by malId, so the null fields are fine.
 */
export function animeFromContinue(item: ContinueItem): AnimeLite {
  return {
    malId: item.malId,
    title: item.title,
    titleEnglish: null,
    image: item.image,
    banner: item.banner,
    logo: null,
    synopsis: null,
    type: item.type,
    ratingShort: null,
    status: null,
    airing: false,
    season: null,
    year: null,
    durationMin: null,
    score: null,
    rank: null,
    popularity: null,
    totalEpisodes: item.totalEpisodes || item.episode,
    nextEpisodeAt: null,
    nextEpisodeNum: null,
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
 * Fresh anime (no stored preference) follow the Settings "Prefer DUB" flag.
 */
export function getLangPref(malId?: number): LangPref {
  try {
    const store = readLangPref();
    const perAnime = malId != null ? store.byAnime?.[String(malId)] : undefined;
    if (perAnime) return perAnime;
    if (store.global) return store.global;
    const s = readAppSettings();
    return { lang: s.preferDub ? "dub" : "sub", server: "zoko" };
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

/* ---------------- App settings (the Settings screen) ---------------- */

/**
 * Viewer-owned app preferences, all local to this device: playback defaults,
 * subtitle look, app theme (accent) and the custom app icon. The Settings
 * screen edits them; WatchView / the details page / the document head read
 * them. Ships with sensible defaults so first-run needs nothing.
 */

export type SubSize = "sm" | "md" | "lg" | "xl";
export type SubOutline = "shadow" | "outline" | "none";

export interface AppSettings {
  // playback
  preferDub: boolean; // new anime default to DUB when a real one exists
  autoSkipIntro: boolean; // auto-jump the opening when its skip window is known
  autoSkipOutro: boolean; // same for the ending
  autoNext: boolean; // roll straight into the next episode on end
  // subtitles
  subSize: SubSize;
  subColor: string;
  subBg: number; // caption backdrop darkness, 0-100
  subOutline: SubOutline;
  // appearance
  accent: string; // ACCENTS id — drives --accent / --accent-deep everywhere
  iconDataUrl: string | null; // custom home-screen icon (square image, data URL)
}

export const SUB_SIZES: Array<{ id: SubSize; name: string; px: number }> = [
  { id: "sm", name: "Small", px: 14 },
  { id: "md", name: "Normal", px: 19 },
  { id: "lg", name: "Large", px: 26 },
  { id: "xl", name: "Huge", px: 34 },
];

export const SUB_COLORS = ["#ffffff", "#ffe08a", "#7fe9de", "#ff9ad5", "#a5f0a0"];

export const ACCENTS: Array<{ id: string; name: string; color: string; deep: string }> = [
  { id: "crimson", name: "Crimson", color: "#d32f2f", deep: "#8e1a1a" },
  { id: "sakura", name: "Sakura", color: "#ff6f9c", deep: "#b23a63" },
  { id: "midnight", name: "Midnight", color: "#8b5cf6", deep: "#5b3bb8" },
  { id: "ocean", name: "Ocean", color: "#38bdf8", deep: "#1d7fb8" },
  { id: "emerald", name: "Emerald", color: "#34d399", deep: "#1d8f68" },
  { id: "gold", name: "Gold", color: "#e9b949", deep: "#a8740f" },
];

export const DEFAULT_SETTINGS: AppSettings = {
  preferDub: false,
  autoSkipIntro: false,
  autoSkipOutro: false,
  autoNext: false,
  subSize: "md",
  subColor: "#ffffff",
  subBg: 35,
  subOutline: "shadow",
  accent: "crimson",
  iconDataUrl: null,
};

const SETTINGS_KEY = "animetest123.settings";
/**
 * The custom app icon lives under its OWN key — never inside the settings
 * record. It is the one value that can be large (a data URL), and a settings
 * write that silently exceeds the localStorage quota would make EVERY toggle
 * on the Settings screen stop applying (the write fails, the store snapshot
 * never changes, the UI shows nothing happening — the desktop "settings don't
 * change" bug). Playback/subtitle/theme toggles are now ~300 bytes and cannot
 * be poisoned by the icon.
 */
const SETTINGS_ICON_KEY = "animetest123.appicon";
const SETTINGS_EVENT = "appsettings-changed";

let iconMigrated = false;
/**
 * One-time per page load: older builds stored the (potentially huge) custom
 * icon INSIDE the settings record — move it to its own slot so the settings
 * toggles can never be poisoned by its size again.
 */
function migrateLegacyIcon(): void {
  if (iconMigrated || typeof window === "undefined") return;
  iconMigrated = true;
  try {
    if (window.localStorage.getItem(SETTINGS_ICON_KEY) != null) return;
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    if (parsed.iconDataUrl) {
      window.localStorage.setItem(SETTINGS_ICON_KEY, JSON.stringify(parsed.iconDataUrl));
      const legacy = { ...parsed, iconDataUrl: undefined };
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(legacy));
    }
  } catch {
    /* best effort — the icon is cosmetic */
  }
}

export function readAppSettings(): AppSettings {
  migrateLegacyIcon();
  return {
    ...DEFAULT_SETTINGS,
    ...readJson<Partial<AppSettings>>(SETTINGS_KEY, {}),
    // the icon rides in its own slot (see SETTINGS_ICON_KEY)
    iconDataUrl: readJson<string | null>(SETTINGS_ICON_KEY, null) ?? null,
  };
}

function subscribeSettings(onChange: () => void) {
  window.addEventListener(SETTINGS_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(SETTINGS_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function getSettingsSnapshot(): string {
  return window.localStorage.getItem(SETTINGS_KEY) ?? "{}";
}

function getSettingsServerSnapshot(): string {
  return "{}";
}

/** Reactive settings for components (re-renders on every change). */
export function useAppSettings(): AppSettings {
  const raw = useSyncExternalStore(subscribeSettings, getSettingsSnapshot, getSettingsServerSnapshot);
  // one corrupted settings key used to THROW during render in every consumer
  // (player included) and white-screen the whole app — guard like readJson
  let parsed: Partial<AppSettings> = {};
  if (raw && raw !== "{}") {
    try {
      parsed = JSON.parse(raw) as Partial<AppSettings>;
    } catch {
      parsed = {};
    }
  }
  const base = { ...DEFAULT_SETTINGS, ...parsed };
  // merge the separately-stored icon reactively (it changes with the same event)
  base.iconDataUrl = readJson<string | null>(SETTINGS_ICON_KEY, null) ?? null;
  return base;
}

export function updateAppSettings(patch: Partial<AppSettings>): AppSettings {
  // icon moves are handled in their own storage slot — keep them OUT of the
  // settings record so a big data URL can never blow the quota for a toggle
  const { iconDataUrl: iconPatch, ...rest } = patch;
  if (iconPatch !== undefined) {
    try {
      if (iconPatch == null) window.localStorage.removeItem(SETTINGS_ICON_KEY);
      else window.localStorage.setItem(SETTINGS_ICON_KEY, JSON.stringify(iconPatch));
    } catch {
      /* icon storage full/blocked — the icon is cosmetic; everything else
         below still applies and the UI still updates */
    }
  }
  const next = { ...readAppSettings(), ...rest, iconDataUrl: iconPatch !== undefined ? iconPatch : readAppSettings().iconDataUrl };
  writeJson(SETTINGS_KEY, { ...next, iconDataUrl: undefined });
  window.dispatchEvent(new Event(SETTINGS_EVENT));
  applySettingsToDocument(next);
  return next;
}

/** One-time read for non-reactive callers (boot, lang default). */
export function accentColorOf(id: string): { color: string; deep: string } {
  const a = ACCENTS.find((x) => x.id === id) ?? ACCENTS[0];
  return { color: a.color, deep: a.deep };
}

/**
 * Push the current settings into the document so EVERYTHING not explicitly
 * styled by a component follows along:
 *   - accent  -> CSS custom props --accent / --accent-deep (nav, buttons,
 *                switches, the settings screen itself)
 *   - subtitle look -> a `video::cue` rule (size / color / backdrop /
 *                outline) that native subtitle tracks pick up
 *   - app icon -> favicon + apple-touch-icon + a blob manifest so a fresh
 *                "Add to Home Screen" carries the custom icon (iOS applies
 *                the icon at add time; Android at install time — best effort
 *                by platform design)
 */
export function applySettingsToDocument(s: AppSettings): void {
  if (typeof document === "undefined") return;

  const { color, deep } = accentColorOf(s.accent);
  document.documentElement.style.setProperty("--app-accent", color);
  document.documentElement.style.setProperty("--app-accent-deep", deep);

  const px = (SUB_SIZES.find((x) => x.id === s.subSize) ?? SUB_SIZES[1]).px;
  const bg = Math.max(0, Math.min(100, s.subBg)) / 100;
  const shadows =
    s.subOutline === "none"
      ? "none"
      : s.subOutline === "outline"
        ? `-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 2px 3px rgba(0,0,0,.9)`
        : `0 1px 4px rgba(0,0,0,.9), 0 0 8px rgba(0,0,0,.55)`;
  const css = `video::cue { color: ${s.subColor}; background: rgba(0, 0, 0, ${bg}); text-shadow: ${shadows}; font-size: ${px}px; }`;
  let tag = document.getElementById("sub-cue-style") as HTMLStyleElement | null;
  if (!tag) {
    tag = document.createElement("style");
    tag.id = "sub-cue-style";
    document.head.appendChild(tag);
  }
  tag.textContent = css;

  // custom app icon — swap every icon-ish link head tag
  try {
    if (s.iconDataUrl) {
      for (const [rel, sizes] of [
        ["icon", "32x32"],
        ["apple-touch-icon", "180x180"],
      ] as const) {
        let link = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
        if (!link) {
          link = document.createElement("link");
          link.rel = rel;
          link.sizes = sizes;
          document.head.appendChild(link);
        }
        link.href = s.iconDataUrl;
      }
      // Android reads icons from the manifest at install time — build a
      // one-off blob manifest carrying the custom image at both sizes
      const manifest = {
        name: "Clyle",
        short_name: "Clyle",
        start_url: "/",
        display: "standalone",
        background_color: "#0a0a0a",
        theme_color: "#0a0a0a",
        icons: [
          { src: s.iconDataUrl, sizes: "192x192", type: "image/png" },
          { src: s.iconDataUrl, sizes: "512x512", type: "image/png" },
        ],
      };
      const url = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: "application/manifest+json" }));
      const manLink = document.head.querySelector<HTMLLinkElement>('link[rel="manifest"]');
      if (manLink) manLink.href = url;
    }
  } catch {
    /* icon theming is cosmetic — never break the app over it */
  }
}

/**
 * Turn a user-chosen image into a home-screen icon data URL, DOWNSCALED on a
 * canvas so it can never blow the localStorage quota again (a full-res phone
 * photo as a data URL is multiple MB — that used to be stored raw INSIDE the
 * settings record, silently killing every settings write afterwards).
 * PNG keeps its transparency at 384px; everything else becomes a 512px JPEG.
 */
export async function fileToAppIconDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Not an image");
  if (file.size > 25_000_000) throw new Error("Image too large (max ~25 MB)");

  const url = URL.createObjectURL(file);
  let img: HTMLImageElement;
  try {
    img = await new Promise<HTMLImageElement>((res, rej) => {
      const el = new Image();
      el.onload = () => res(el);
      el.onerror = () => rej(new Error("Could not read image"));
      el.src = url;
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5_000);
  }

  const png = file.type.includes("png");
  const S = png ? 384 : 512; // covers the 192/512 manifest slots
  const side = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height) || S;
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  const sw = side, sh = side;
  const sx = ((img.naturalWidth || img.width) - sw) / 2;
  const sy = ((img.naturalHeight || img.height) - sh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, S, S);
  return png ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.85);
}
