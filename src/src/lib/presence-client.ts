"use client";

/**
 * Live presence — client half.
 *
 * A single heartbeat lifecycle for the whole app (mounted once from the
 * root layout, next to AccountSync): every open tab/device beats
 * POST /api/presence every 45s while the app is VISIBLE, re-beats when the
 * PWA comes back to the foreground, and sends a keepalive "leave" beacon on
 * pagehide so closing the tab frees its seat immediately.
 *
 * Every heartbeat response is the server's current aggregate (total online
 * + platform + region breakdown). The latest aggregate lands in a tiny
 * external store that <PresenceBadge /> (homepage, top-left) subscribes to
 * via useSyncExternalStore — the same pattern profile-store uses.
 *
 * Module-scope state survives view switches inside the SPA, so navigating
 * home → details → home never restarts the heartbeat, and multiple mounts
 * (StrictMode double-invoke, badge + future widgets) stay one lifecycle.
 */

export interface PresenceData {
  online: number;
  platforms: Array<{ name: string; count: number }>;
  regions: Array<{ code: string; count: number }>;
}

const HEARTBEAT_MS = 45_000;
const REBEAT_MIN_GAP_MS = 15_000; // visibilitychange flood guard

let started = false;
let lastBeatAt = 0;
let latest: PresenceData | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function setLatest(d: PresenceData | null) {
  latest = d;
  emit();
}

async function beat(leave = false) {
  lastBeatAt = Date.now();
  try {
    // dynamic import keeps getUserId's profile-registration side effect
    // out of paths that never beat, and avoids a circular import at load
    const { getUserId } = await import("@/lib/profile-store");
    const res = await fetch("/api/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ uid: getUserId(), leave }),
      // keepalive lets the leave beacon survive the page being torn down
      keepalive: leave,
    });
    if (!res.ok) return;
    const d = (await res.json()) as PresenceData;
    if (!leave && typeof d?.online === "number") setLatest(d);
  } catch {
    /* offline / lambda hiccup — the next heartbeat heals it */
  }
}

/** Idempotently start the app-wide heartbeat lifecycle. */
export function ensurePresenceHeartbeat() {
  if (started || typeof window === "undefined") return;
  started = true;
  beat();
  const onVis = () => {
    if (document.visibilityState === "visible" && Date.now() - lastBeatAt > REBEAT_MIN_GAP_MS) {
      beat(); // PWA foreground return / tab switch back
    }
  };
  // pagehide = real navigation / tab close / reload (NOT tab backgrounding
  // — that is visibilitychange's job). Always beacon: on mobile Safari the
  // document may already report visibilityState "hidden" by the time
  // pagehide runs, so checking it here would drop the leave beacon.
  const onHide = () => {
    beat(true).catch(() => undefined);
  };
  // bfcache restore: pagehide freed the seat when the page was frozen —
  // take it back the moment the page comes back
  const onShow = (e: PageTransitionEvent) => {
    if (e.persisted) beat();
  };
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("pagehide", onHide);
  window.addEventListener("pageshow", onShow);
  setInterval(() => {
    if (document.visibilityState === "visible") beat();
  }, HEARTBEAT_MS);
}

/* ---- tiny external store for the badge (useSyncExternalStore) ---- */

export function subscribePresence(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Stable snapshot: same object reference until a new aggregate lands. */
export function getPresenceSnapshot(): PresenceData | null {
  return latest;
}
