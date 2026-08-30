"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { AnimeLite } from "@/lib/types";

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
