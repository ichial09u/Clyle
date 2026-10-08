"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Wifi, WifiOff, X } from "lucide-react";
import { flushOutbox, localDayKey } from "@/lib/client-store";
import { getUserId } from "@/lib/profile-store";

/* ---- cache warming ----
 * The SW precaches the shell at install, but the catalog DATA for tabs the
 * user never opened would still be cold on the first offline launch. So the
 * page sends the SW its real parameterized URLs (userId/day embedded) and
 * the SW fetches+stashes them. Throttled to once every 6h per device.
 */
const WARM_AT_KEY = "animetest123.warmat";
const WARM_INTERVAL = 6 * 3600_000;

function warmUrlList(): string[] {
  const userId = getUserId();
  return [
    "/api/home",
    `/api/suggestions?userId=${encodeURIComponent(userId)}`,
    `/api/continue?userId=${encodeURIComponent(userId)}`,
    "/api/genres",
    "/api/arriving",
    "/api/top10",
    "/api/top10-events",
    `/api/watchtime?day=${encodeURIComponent(localDayKey())}&limit=10`,
    "/api/latest",
  ];
}

function warmServiceWorker() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (navigator.onLine === false) return;
  try {
    const last = Number(window.localStorage.getItem(WARM_AT_KEY) || 0);
    if (Date.now() - last < WARM_INTERVAL) return;
    window.localStorage.setItem(WARM_AT_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
  const urls = warmUrlList();
  const post = (sw: ServiceWorker | null) => sw?.postMessage({ type: "clyle:warm", urls });
  if (navigator.serviceWorker.controller) {
    post(navigator.serviceWorker.controller);
  } else {
    // first load after an SW update — the controller appears once it claims
    navigator.serviceWorker.ready
      .then((reg) => post(navigator.serviceWorker.controller || reg.active || null))
      .catch(() => undefined);
  }
}

/**
 * Offline mode — the visible half of offline viewing.
 *
 * What the service worker (public/sw.js) can't do is talk to the user, so
 * this component owns the experience around offline:
 *
 *   - POPUP when the connection drops: explains that Clyle keeps working —
 *     browsing and every episode already watched on this device still play,
 *     and progress saves locally and syncs on reconnect. Shown once per
 *     offline transition (never nagged again until the next drop).
 *   - PILL while offline: a dismissible status chip, hidden while the video
 *     is fullscreen so it never sits on top of playback.
 *   - RECONNECT toast + sync: when the network returns, the progress/watchtime
 *     outbox (client-store) is flushed and the user sees "progress synced".
 *   - HEARTBEAT while offline: mobile browsers (iOS PWA especially) sometimes
 *     never fire `online`; a 15s probe of the manifest catches the comeback.
 *   - CATCH-UP: opening the app while online also flushes any outbox left
 *     behind by a previous session that died offline.
 */
export default function OfflineManager() {
  const [mounted, setMounted] = useState(false);
  const [offline, setOffline] = useState(false);
  const [popup, setPopup] = useState(false);
  const [pillHidden, setPillHidden] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const beatRef = useRef<number | null>(null);
  const toastTimer = useRef<number | null>(null);
  const offlineRef = useRef(false);

  const showToast = useCallback((text: string, ms = 4_500) => {
    setToast(text);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), ms);
  }, []);

  const goOnline = useCallback(async () => {
    if (!offlineRef.current) return;
    offlineRef.current = false;
    setOffline(false);
    setPopup(false);
    if (beatRef.current) {
      window.clearInterval(beatRef.current);
      beatRef.current = null;
    }
    const queued = await flushOutbox();
    showToast(queued > 0 ? `Back online — ${queued} update${queued === 1 ? "" : "s"} synced` : "Back online");
    warmServiceWorker();
  }, [showToast]);

  const goOffline = useCallback(() => {
    if (offlineRef.current) return;
    offlineRef.current = true;
    setOffline(true);
    setPillHidden(false);
    setPopup(true); // once per transition
  }, []);

  useEffect(() => {
    setMounted(true);
    const startOffline = typeof navigator !== "undefined" && navigator.onLine === false;
    if (startOffline) {
      offlineRef.current = true;
      setOffline(true);
      // don't fight the app's first paint
      window.setTimeout(() => setPopup(true), 1_200);
    } else {
      // catch-up: replay anything queued by a previous offline session, then
      // (throttled) re-warm the offline caches while we have wifi
      const flushT = window.setTimeout(() => void flushOutbox(), 3_000);
      const warmT = window.setTimeout(warmServiceWorker, 8_000);
      return () => {
        window.clearTimeout(flushT);
        window.clearTimeout(warmT);
      };
    }
  }, []);

  useEffect(() => {
    const onOnline = () => void goOnline();
    const onOffline = () => goOffline();
    const onFs = () => setFullscreen(Boolean(document.fullscreenElement));
    const onVisible = () => {
      // returning to the app while online is another sync opportunity
      if (document.visibilityState === "visible" && !offlineRef.current) void flushOutbox();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("fullscreenchange", onFs);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [goOnline, goOffline]);

  // heartbeat: browsers (esp. iOS PWA) can miss the online event entirely.
  // HEAD on purpose — the service worker only intercepts GET, so a cached
  // GET answer used to "prove" connectivity while still offline (a lying
  // Back-online toast every 15s); HEAD always hits the real network.
  useEffect(() => {
    if (!offline || beatRef.current) return;
    const probe = async () => {
      try {
        const res = await fetch("/manifest.webmanifest", {
          method: "HEAD",
          cache: "no-store",
          signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) void goOnline();
      } catch {
        /* still offline */
      }
    };
    beatRef.current = window.setInterval(probe, 15_000);
    return () => {
      if (beatRef.current) {
        window.clearInterval(beatRef.current);
        beatRef.current = null;
      }
    };
  }, [offline, goOnline]);

  if (!mounted) return null;

  // mid-playback the player owns the screen — its own offline copy handles
  // the message there; a modal dropping over the controls once per drop
  // (and never in fullscreen, where this component is hidden anyway) was
  // pure interruption
  const playerOpen = typeof document !== "undefined" && document.body.dataset.playerOpen === "1";

  return (
    <>
      {/* ---- offline popup (once per drop, never over the player) ---- */}
      {popup && !playerOpen ? (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 backdrop-blur-sm p-6"
          role="dialog"
          aria-modal="true"
          aria-label="You are offline"
        >
          <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#0c0c0f] p-6 text-center shadow-2xl">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[#d32f2f]/15 border border-[#d32f2f]/30">
              <WifiOff className="h-6 w-6 text-[#ff6b6b]" />
            </div>
            <h2 className="font-slab mt-4 text-lg font-bold text-white">You&apos;re offline</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-white/60">
              Clyle keeps working without internet — browse your catalog and keep watching
              episodes you&apos;ve played on this device, in the quality you watched them.
              Everything you watch now is saved and syncs the moment you&apos;re back online.
            </p>
            <button
              onClick={() => setPopup(false)}
              className="mt-5 w-full rounded-xl bg-white py-3 text-sm font-semibold text-black active:scale-[0.98] transition-transform"
            >
              Keep watching
            </button>
          </div>
        </div>
      ) : null}

      {/* ---- offline pill (hidden in fullscreen + dismissible) ---- */}
      {offline && !popup && !pillHidden && !fullscreen ? (
        <div className="fixed bottom-[76px] left-1/2 z-[45] -translate-x-1/2 lg:bottom-6 lg:left-[92px] lg:translate-x-0">
          <div className="flex items-center gap-2 rounded-full border border-white/10 bg-[#141418]/95 px-4 py-2 shadow-lg backdrop-blur">
            <WifiOff className="h-3.5 w-3.5 text-[#ff6b6b]" />
            <span className="text-xs text-white/70">Offline — saved episodes still play</span>
            <button
              onClick={() => setPillHidden(true)}
              aria-label="Dismiss offline notice"
              className="ml-1 text-white/40 hover:text-white/70"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ) : null}

      {/* ---- reconnect / sync toast ---- */}
      {toast ? (
        <div className="fixed bottom-[76px] left-1/2 z-[46] -translate-x-1/2 lg:bottom-6 lg:left-[92px] lg:translate-x-0">
          <div className="flex items-center gap-2 rounded-full bg-white px-4 py-2 shadow-xl">
            {offline ? (
              <WifiOff className="h-3.5 w-3.5 text-[#d32f2f]" />
            ) : toast.includes("synced") ? (
              <Check className="h-3.5 w-3.5 text-green-600" />
            ) : (
              <Wifi className="h-3.5 w-3.5 text-green-600" />
            )}
            <span className="text-xs font-semibold text-black">{toast}</span>
          </div>
        </div>
      ) : null}
    </>
  );
}
