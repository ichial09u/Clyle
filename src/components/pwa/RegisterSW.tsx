"use client";

import { useEffect } from "react";

/**
 * Registers the minimal Clyle service worker (/public/sw.js).
 *
 * Production only — in dev it would fight Next's HMR. Registration is
 * delayed a beat so it never competes with first paint. The SW itself is a
 * network pass-through whose only job is to make Android Chrome treat the
 * site as an installable PWA (beforeinstallprompt) and to show an offline
 * notice for lost-connection navigations.
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
