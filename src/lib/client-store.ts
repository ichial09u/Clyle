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
  fetch(`/api/progress?userId=${encodeURIComponent(getUserId())}&malId=${malId}`, { method: "DELETE" }).catch(
    () => undefined,
  );
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

  type Row = { item: ContinueItem; at: number };
  const byAnime = new Map<number, Row>();

  for (const it of serverItems) {
    if (it.completed) continue;
    byAnime.set(it.malId, { item: it, at: Date.parse(it.updatedAt) });
  }

  for (const [malId, eps] of Object.entries(localAll)) {
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
