"use client";

import { useSyncExternalStore } from "react";

/**
 * Shared coarse clock for airing badges ("New episode soon" on cards).
 *
 * Dozens of poster cards need to know "is the next episode within 3 days
 * NOW?" — a setInterval per card would mean ~100 timers on the home screen.
 * This store ticks ONCE every 30s and every subscriber re-renders together;
 * the interval exists only while at least one component is subscribed.
 *
 * 30s granularity is plenty: the visibility boundary moves once per 3-day
 * window, and the underlying air times update on data syncs anyway.
 */
const TICK_MS = 30_000;

let now = Date.now();
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function ensureTimer() {
  if (timer) return;
  timer = setInterval(() => {
    now = Date.now();
    subs.forEach((cb) => cb());
  }, TICK_MS);
}

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  ensureTimer();
  return () => {
    subs.delete(cb);
    if (subs.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Milliseconds since epoch, re-rendering the caller every 30s. */
export function useAiringNow(): number {
  return useSyncExternalStore(subscribe, () => now);
}

/** "New episode soon" shows when the next episode airs within this window. */
export const NEW_EPISODE_SOON_MS = 3 * 24 * 60 * 60 * 1000;
