"use client";

import { useEffect } from "react";

/**
 * Registers the Clyle service worker (/public/sw.js).
 *
 * Production only — in dev it would fight Next's HMR. Registration is
 * delayed a beat so it never competes with first paint. The SW is the
 * offline engine: it caches the app shell, build assets, catalog API
 * responses, poster art, and (crucially) the HLS playlists/segments that
 * stream through our own /api/stream/proxy — which is what makes already-
 * watched episodes play with no connection. Progress writes made offline
 * are queued client-side (client-store outbox) and replayed on reconnect.
 */
export default function RegisterSW() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const t = window.setTimeout(() => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
    }, 1_500);
    return () => window.clearTimeout(t);
  }, []);
  return null;
}
