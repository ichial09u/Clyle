"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Hls, { type Level } from "hls.js";
import {
  ChevronLeft, Download, Lock, Unlock, SlidersHorizontal, Gauge, Scan, SkipBack, SkipForward,
  Check, Play, Pause, Maximize, Minimize, Subtitles, Zap, Cast, RotateCcw, RotateCw, FastForward,
} from "lucide-react";
import type { AnimeLite } from "@/lib/types";
import { zokoPlayerUrl, zokoDownloadUrl, estimateSizeMB, type Lang, type ServerId, isBackupServer } from "@/lib/zoko";
import { setProgress, getEpProgress, fetchServerProgress, saveProgressDetailed, recordWatchSeconds, setLangPref, clearProgressTombstone, useAppSettings } from "@/lib/client-store";
import {
  ensureCastSdk, castLoad, castLoadNext, castStop, castPosition, castDuration,
  castIsPlaying, castTogglePlay, castSeek, getCastState, onCastStateChange,
  onCastMediaError, type CastState,
} from "@/lib/cast";
import { pickSubtitleTrack } from "@/lib/subtitles";
import { artUrl } from "@/lib/art";
import { enqueueEpisodeSave, getSavedEpisode, type SaveState } from "@/lib/offline-download";

type Panel = null | "quality" | "speed" | "subs";
type Resolved = { src: string; subtitles: Array<{ lang: string; label: string; src: string }>; skip?: { intro?: { start: number; end: number }; outro?: { start: number; end: number } }; provider?: string; referer?: string | null; providerName?: string; pk?: string | null; heights?: number[] };

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

// `referer` rides along as `rf` on the FIRST playlist call — the proxy allows
// rf-carrying requests whose host isn't in its static allowlist, which is how
// the Anivexa backup network's rotating CDN hosts get through. `pk` rides the
// same way: FlixCloud's XOR-obfuscated playlists get peeled by the proxy.
// (A src that IS already a proxy URL — the FlixCloud stored master — passes
// through untouched so it doesn't get double-wrapped.)
const proxyUrl = (u: string, type: "m3u8" | "seg" | "vtt", referer?: string | null, pk?: string | null) =>
  u.startsWith("/api/stream/proxy")
    ? u
    : `/api/stream/proxy?type=${type}&u=${encodeURIComponent(u)}${referer ? `&rf=${encodeURIComponent(referer)}` : ""}${pk ? `&pk=${encodeURIComponent(pk)}` : ""}`;

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

export default function WatchView({
  anime,
  episode,
  lang: initialLang,
  server = "zoko",
  onBack,
  onEpisodeChange,
}: {
  anime: AnimeLite;
  episode: number;
  lang: Lang;
  server?: ServerId;
  onBack: () => void;
  onEpisodeChange: (ep: number, lang: Lang, server: ServerId) => void;
}) {
  const [lang, setLang] = useState<Lang>(initialLang);
  // remember what the player is using so the episode list's server sheet
  // leads with the same language when you press back (DUB stays DUB)
  useEffect(() => {
    // the lang-pref store only tracks the main servers; a backup server
    // session remembers its language under Zoko
    setLangPref(anime.malId, { lang, server: server === "kiwi" ? "kiwi" : "zoko" });
  }, [anime.malId, lang, server]);
  const [stream, setStream] = useState<Resolved | null>(null);
  const [streamError, setStreamError] = useState(false);
  const [iframeFallback, setIframeFallback] = useState(false);
  // ref mirror for long-lived listeners (the fullscreenchange bridge + Esc
  // handler must know the embedded Zoko player is up without re-binding)
  const iframeFallbackRef = useRef(false);
  iframeFallbackRef.current = iframeFallback;
  // does this title have a REAL English dub? (null = still asking).
  // The server /api/stream also validates every dub play, so a stale value
  // can never put Japanese audio under a DUB label — this only drives the UI.
  const [hasDub, setHasDub] = useState<boolean | null>(null);
  // per-EPISODE dub boundaries (highest episode with a proven real dub per
  // server chain; 0 = none, null = unprobed). Gates the SUB/DUB toggle per
  // episode — the anime-level verdict can't express "the dub hasn't reached
  // this arc yet" (One Piece/Elbaph).
  const [dubThrough, setDubThrough] = useState<{ s1: number | null; s2: number | null }>({ s1: null, s2: null });
  // episodes with a DEFINITIVE no-dub proof on BOTH chains (holes inside a
  // dubbed range — DAN DA DAN S1 eps 4-6). The prefix boundary can't express
  // these; this list can.
  const [dubMissing, setDubMissing] = useState<number[]>([]);
  // real episode titles ("Ryomen Sukuna") from the episodes endpoint — the
  // player header prefers them over the plain "Episode N" + language label
  const [epTitles, setEpTitles] = useState<Record<number, string>>({});
  // which servers carry that dub ("zoko", "kiwi") — when the player's current
  // server isn't one of them, toggling DUB auto-switches to one that is
  const [dubServers, setDubServers] = useState<Array<ServerId> | null>(null);
  // BACKUP DUB servers (the Anivexa network) — per-title; `covered` lists the
  // exact episodes that provider dubs, so buttons show only where real
  // coverage exists and the main chain can't serve the dub itself
  const [backupDub, setBackupDub] = useState<Array<{ server: string; provider: string; name: string; through: number | null; covered: number[] }> | null>(null);
  // generic in-player toast (dub fallback notices); cast errors use castMsg
  const [playerMsg, setPlayerMsg] = useState<string | null>(null);
  // live connection state — drives the offline hints (what plays offline vs
  // what needs the network is explained right in the player)
  const [offline, setOffline] = useState(false);
  // offline-save progress ("Saving for offline · 43%" pill)
  const [saveState, setSaveState] = useState<SaveState | null>(null);
  // desktop ↑/↓ volume pill — percent shown for ~1.4s after a press, else hidden
  const [volumePct, setVolumePct] = useState<number | null>(null);
  // live fullscreen flag — drives the manual Full screen/Exit control on PC
  const [fsActive, setFsActive] = useState(false);
  useEffect(() => {
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    const sync = () => setFsActive(!!(doc.fullscreenElement || doc.webkitFullscreenElement));
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, []);

  // per-episode DUB availability for the CURRENT episode: the highest proven
  // boundary across both chains (either chain can serve the dub via fallback)
  const epDubThru =
    dubThrough.s1 != null || dubThrough.s2 != null
      ? Math.max(dubThrough.s1 ?? 0, dubThrough.s2 ?? 0)
      : null;
  const epHasDub: boolean | null =
    epDubThru != null ? episode <= epDubThru && !dubMissing.includes(episode) : hasDub;

  useEffect(() => {
    // the exit-animation copy must not fire network effects
    if (shellRef.current?.closest('[data-leaving="true"]')) return;
    let ok = true;
    fetch(`/api/anime/${anime.malId}/episodes`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { hasDub?: boolean; dubServers?: ServerId[]; dubThrough?: { s1: number | null; s2: number | null }; dubMissing?: number[]; backupDub?: Array<{ server: string; provider: string; name: string; through: number | null; covered: number[] }> | null; episodes?: Array<{ number: number; title?: string | null }> } | null) => {
        if (!ok || !d) return;
        if (typeof d.hasDub === "boolean") setHasDub(d.hasDub);
        if (Array.isArray(d.dubServers)) setDubServers(d.dubServers);
        if (d.dubThrough && (d.dubThrough.s1 != null || d.dubThrough.s2 != null)) setDubThrough(d.dubThrough);
        if (Array.isArray(d.dubMissing)) setDubMissing(d.dubMissing);
        if (Array.isArray(d.backupDub)) setBackupDub(d.backupDub);
        if (Array.isArray(d.episodes)) {
          const map: Record<number, string> = {};
          for (const e of d.episodes) if (e.title) map[e.number] = e.title;
          setEpTitles(map);
        }
      })
      .catch(() => undefined);
    return () => {
      ok = false;
    };
  }, [anime.malId]);

  // toast timers must not outlive the player — the 12s cast-failure pill and
  // friends used to fire after unmount
  const toastTimersRef = useRef<number[]>([]);
  useEffect(
    () => () => {
      for (const t of toastTimersRef.current) window.clearTimeout(t);
    },
    [],
  );
  const trackToastTimer = (id: number) => {
    toastTimersRef.current.push(id);
    if (toastTimersRef.current.length > 12) toastTimersRef.current = toastTimersRef.current.slice(-12);
  };

  const showPlayerMsg = (text: string, ms = 6_000) => {
    setPlayerMsg(text);
    trackToastTimer(window.setTimeout(() => setPlayerMsg((m) => (m === text ? null : m)), ms));
  };

  // player-open flag for global surfaces (sign-in nudge, offline popup):
  // they read body[data-player-open] so a modal can never drop over the
  // running player
  useEffect(() => {
    document.body.dataset.playerOpen = "1";
    return () => {
      delete document.body.dataset.playerOpen;
    };
  }, []);

  // one auto language-fallback per (malId, episode) — no dub->sub->dub ping-pong
  const fallbackTriedRef = useRef<string>("");

  // track the connection so the player can explain itself when offline
  useEffect(() => {
    const sync = () => setOffline(typeof navigator !== "undefined" && navigator.onLine === false);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  // thumb position while the user is dragging the seek bar — the bar and the
  // elapsed label follow the THUMB during a drag, the <video> only seeks ONCE
  // (on release); per-pixel seeking used to abort HLS fragments constantly
  const [scrub, setScrub] = useState<number | null>(null);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [levels, setLevels] = useState<Array<Level>>([]);
  const [quality, setQuality] = useState<"auto" | number>("auto");
  const [speed, setSpeed] = useState(1);
  const [subsOn, setSubsOn] = useState(true);
  // which caption language the user picked (index into stream.subtitles);
  // null = auto (the real English track when the source has it, else the
  // source's own default — see pickSubtitleTrack)
  const [subIdx, setSubIdx] = useState<number | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [locked, setLocked] = useState(false);
  const [resizeMode, setResizeMode] = useState<0 | 1 | 2>(0);
  const [ready, setReady] = useState(false);

  // resume + cast state
  const [resumedFrom, setResumedFrom] = useState<number | null>(null);
  const [castState, setCastState] = useState<CastState>(getCastState());
  const [castMsg, setCastMsg] = useState<string | null>(null);
  // in-player overlay visibility (controls live INSIDE the player surface)
  const [uiVisible, setUiVisible] = useState(true);

  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const seekRef = useRef<HTMLInputElement>(null);
  const resumeAtRef = useRef(0);
  // set when the user switches stream server mid-play so the new source
  // resumes at the exact second instead of restarting
  const pendingSeekRef = useRef<number | null>(null);
  // which (malId, episode) the staged spot belongs to — a staged seek must
  // never leak into a DIFFERENT episode's playback
  const stagedForRef = useRef<string>("");
  const castStateRef = useRef<CastState>(getCastState());
  const castMediaUrlRef = useRef("");
  const hideTimerRef = useRef<number | null>(null);
  const panelRef = useRef<Panel>(null);
  panelRef.current = panel;
  const lockedRef = useRef(false);
  lockedRef.current = locked;
  const playingRef = useRef(false);
  playingRef.current = playing;
  const streamErrorRef = useRef(false);
  streamErrorRef.current = streamError;
  const downloadOpenRef = useRef(false);
  downloadOpenRef.current = downloadOpen;
  // watch-time accrual (Top 10 Today): wall clock of the last tick/transition;
  // deltas only ever accrue while playback is actually running
  const lastActiveRef = useRef(Date.now());

  /* -------- player header titles -------- */
  // Prefer the real episode title from MAL ("Episode 1: Ryomen Sukuna");
  // fall back to the classic numbered label (which still shows the language)
  // when no title exists yet or the list is still loading.
  const epTitle = epTitles[episode]?.trim() || null;
  const playerTitle = epTitle ? `Episode ${episode}: ${epTitle}` : `Episode ${episode} ${lang.toUpperCase()}`;
  const castTitle = epTitle
    ? `${anime.title} — Episode ${episode}: ${epTitle}`
    : `${anime.title} — Episode ${episode} (${lang.toUpperCase()})`;
  // mirror for closures that outlive their render (the hls.js effect hands
  // the episode to the TV on MANIFEST_PARSED — must read the latest title)
  const castTitleRef = useRef(castTitle);
  castTitleRef.current = castTitle;

  /* -------- auto-hide the in-player controls (like a real video app) -------- */
  const showUi = useCallback((autoHide = true) => {
    setUiVisible(true);
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    if (autoHide) {
      hideTimerRef.current = window.setTimeout(() => {
        const v = videoRef.current;
        if (v && !v.paused && !v.ended && !panelRef.current && !lockedRef.current) setUiVisible(false);
      }, 3200);
    }
  }, []);

  useEffect(() => {
    // always show controls while paused, a panel is open, or locked
    if (!playing || panel || locked || streamError || castMsg) {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
      setUiVisible(true);
    } else {
      showUi();
    }
  }, [playing, panel, locked, streamError, castMsg, showUi]);

  useEffect(() => () => {
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
  }, []);

  /* -------- auto-fullscreen on open (like the reference app): picking an
     episode + server drops you straight into fullscreen playback — DESKTOP
     TOO (owner: the browser bar and the taskbar must not show). On leave,
     EVERY exit path (back button, Esc, tab switch) drops fullscreen and the
     rotation lock again. -------- */
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    // the leaving pane renders a throwaway copy of this view for the exit
    // animation — it must not (re-)enter fullscreen
    if (shell.closest('[data-leaving="true"]')) return;

    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => void;
    };
    const el = shell as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
    const currentFs = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
    if (currentFs === shell) return;

    const request = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el);
    if (request) {
      try {
        Promise.resolve(request())
          .then(() => {
            // phones/tablets: keep playback landscape like the reference player
            if (window.matchMedia?.("(pointer: coarse)")?.matches) {
              type Orient = ScreenOrientation & { lock?: (o: "landscape") => Promise<void> };
              const so = screen.orientation as Orient | undefined;
              try {
                void so?.lock?.("landscape")?.catch?.(() => undefined);
              } catch {
                /* iOS Safari has no orientation lock — ignore */
              }
            }
          })
          .catch(() => undefined); // denied/expired — the fixed overlay still covers the screen
      } catch {
        /* e.g. iPhone Safari (no element fullscreen) — non-fatal */
      }
    }

    return () => {
      exitingRef.current = true; // our own teardown — the bridge must not fire
      try {
        screen.orientation?.unlock?.();
      } catch {
        /* unsupported — ignore */
      }
      const fsEl = doc.fullscreenElement ?? doc.webkitFullscreenElement;
      if (fsEl) {
        try {
          if (doc.exitFullscreen) void doc.exitFullscreen().catch(() => undefined);
          else doc.webkitExitFullscreen?.();
        } catch {
          /* ignore */
        }
      }
    };
  }, []);

  /* -------- landscape beyond the fullscreen path (the PWA-reopen fix) --------
     The lock above only runs when requestFullscreen RESOLVES — but a restored
     player (PWA relaunch / process-death reload / lock-screen resume) has no
     user gesture, fullscreen is DENIED, and the lock was never attempted, so
     the player sat in portrait. Standalone PWAs are allowed to lock the
     orientation WITHOUT fullscreen, so: attempt on mount, and re-assert every
     time the app becomes visible again or playback (re)starts. Failed
     attempts (browser tab without fullscreen, iOS) are silently ignored —
     same posture as the fullscreen-gated attempt above.

     The app-switch comeback (the "back to vertical" bug): the OS releases
     the orientation lock while backgrounded, and the FIRST re-lock attempt
     right at visibilitychange can land while the activity is still settling
     and silently fail. So each resume fires a BURST of retries over the
     following two seconds, plus re-asserts on focus/pageshow and every tap
     (all throttled) — by the time the user is looking at the player it is
     locked landscape again. Fullscreen, which died in the background too,
     gets a best-effort silent re-entry (harmless where denied). */
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || shell.closest('[data-leaving="true"]')) return;
    if (!window.matchMedia?.("(pointer: coarse)")?.matches) return; // phones/tablets only
    type Orient = ScreenOrientation & { lock?: (o: "landscape") => Promise<void> };
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    const el = shell as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
    let stopped = false;
    let lastAt = 0;
    const attempt = () => {
      if (stopped) return;
      const now = Date.now();
      if (now - lastAt < 900) return; // throttle the resume/play/tap churn
      lastAt = now;
      const so = screen.orientation as Orient | undefined;
      try {
        const p = so?.lock?.("landscape");
        if (p && typeof p.catch === "function") p.catch(() => undefined);
      } catch {
        /* iOS Safari has no orientation lock — ignore */
      }
    };
    const reassert = () => {
      [0, 300, 900, 1_800].forEach((d) =>
        window.setTimeout(() => {
          if (!stopped) attempt();
        }, d),
      );
    };
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      reassert();
      // fullscreen died in the background as well — try a silent re-entry so
      // the comeback looks exactly like the moment the app was left
      try {
        if (!(doc.fullscreenElement ?? doc.webkitFullscreenElement)) {
          const p = el.requestFullscreen?.() ?? el.webkitRequestFullscreen?.();
          if (p && typeof p.catch === "function") p.catch(() => undefined);
        }
      } catch {
        /* denied without a gesture — the shell is CSS-fullscreen anyway */
      }
    };
    attempt(); // mount: covers PWA reopen straight into a restored player
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pageshow", onVis);
    window.addEventListener("focus", reassert);
    window.addEventListener("pointerdown", reassert);
    const video = videoRef.current;
    video?.addEventListener("play", attempt);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pageshow", onVis);
      window.removeEventListener("focus", reassert);
      window.removeEventListener("pointerdown", reassert);
      video?.removeEventListener("play", attempt);
    };
  }, []);

  /* -------- desktop: moving the mouse wakes / keeps the controls visible -------- */
  const lastMoveRef = useRef(0);
  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType !== "mouse") return; // touch uses tap-to-toggle
      if (panelRef.current || lockedRef.current || streamErrorRef.current) return;
      if (!playingRef.current) return; // paused already forces controls visible
      const now = Date.now();
      if (now - lastMoveRef.current < 250) return; // throttle the timer churn
      lastMoveRef.current = now;
      showUi();
    },
    [showUi],
  );

  /* -------- desktop keyboard: Space = play/pause, ←/→ = skip ±10s,
            ↑/↓ = volume, Escape = close panel/dialog → exit player in ONE
            press (when real fullscreen is up, the browser itself consumes
            the first Esc — the fullscreenchange bridge below turns that
            exact same press into the exit, so it still stays one press).
            Ignored while typing in a field or when a real button/ control
            has focus (Space on a focused button must stay a button press). */
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  // set when WE initiate a fullscreen exit (Esc keydown / unmount cleanup) so
  // the fullscreenchange bridge ignores our own transitions
  const exitingRef = useRef(false);
  const currentTimeRef = useRef(0);
  currentTimeRef.current = currentTime;
  const durationRef = useRef(0);
  durationRef.current = duration;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // the exit-animation copy of this view must ignore keys entirely
      if (shellRef.current?.closest('[data-leaving="true"]')) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      // text-like targets keep the keyboard — but the SEEK RANGE (and other
      // non-text inputs) must not swallow Space/Esc: after dragging the seek
      // bar it keeps focus on PC, and Space used to die until blur (owner QA).
      const textlike =
        tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable ||
        (tag === "INPUT" && (t as HTMLInputElement).type !== "range");
      if (textlike) return;
      // Space on a focused real button must stay a button press — the global
      // handler would preventDefault it and toggle playback instead (e.g.
      // Space on a focused "Next episode" button used to PAUSE the video)
      if (tag === "BUTTON" && (e.key === " " || e.code === "Space")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "Escape") {
        if (e.repeat) return; // holding Esc must not spam-exit
        if (panelRef.current) {
          setPanel(null);
          return;
        }
        if (downloadOpenRef.current) {
          setDownloadOpen(false);
          return;
        }
        // ONE press leaves the player. If real fullscreen is somehow still up
        // AND the browser delivered the key to us (rare), drop it too — the
        // exitingRef guard keeps the fullscreenchange bridge from re-firing.
        if (typeof document !== "undefined" && document.fullscreenElement) {
          // the embedded Zoko player's own fullscreen is its business — the
          // browser exits it; our bridge deliberately ignores that transition
          if (iframeFallbackRef.current) return;
          exitingRef.current = true;
          void document.exitFullscreen().catch(() => undefined);
        }
        onBackRef.current();
        return;
      }

      if (castStateRef.current === "casting") return; // the TV owns transport
      if (e.key === " " || e.code === "Space") {
        e.preventDefault(); // don't scroll the page (even on repeat)
        if (e.repeat) return;
        togglePlay();
        showUi();
        return;
      }
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const base = currentTimeRef.current;
        const target = e.key === "ArrowRight" ? base + 10 : base - 10;
        seekTo(Math.max(0, Math.min(durationRef.current || target, target)));
        showUi();
        return;
      }
      // ↑/↓ = volume in 10% steps (hold to ramp) with a brief on-screen pill,
      // so the change is visible even though the player has no volume slider
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        const video = videoRef.current;
        if (!video) {
          e.preventDefault(); // iframe fallback: don't scroll the page either
          return;
        }
        e.preventDefault(); // don't scroll the page
        const step = e.key === "ArrowUp" ? 0.1 : -0.1;
        video.muted = false;
        video.volume = Math.max(0, Math.min(1, Math.round((video.volume + step) * 10) / 10));
        setVolumePct(Math.round(video.volume * 100));
        showUi();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // the volume pill clears itself shortly after the last ↑/↓ press
  useEffect(() => {
    if (volumePct === null) return;
    const t = window.setTimeout(() => setVolumePct(null), 1_400);
    return () => window.clearTimeout(t);
  }, [volumePct]);

  /* -------- fullscreenchange bridge (desktop): with REAL fullscreen on PC,
     the browser itself consumes the first Esc — the keydown handler above
     never fires. When fullscreen drops while the player is still mounted and
     WE didn't initiate the drop, that WAS the user's Esc press: apply the
     exact same one-press semantics (panel → dialog → leave the player).
     Phones keep their own flow (no Esc key there). -------- */
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia?.("(pointer: coarse)")?.matches) return;
    const onFsChange = () => {
      // the exit-animation copy must never act on fullscreen events
      if (shellRef.current?.closest('[data-leaving="true"]')) return;
      const doc = document as Document & { webkitFullscreenElement?: Element | null };
      if (doc.fullscreenElement || doc.webkitFullscreenElement) {
        exitingRef.current = false; // (re-)entered — our guards start fresh
        return;
      }
      // the embedded Zoko player's fullscreen button makes the IFRAME the
      // fullscreen element — exiting IT is the iframe's own flow, not the
      // user's Esc-to-leave-the-player (this used to dump the viewer home)
      if (iframeFallbackRef.current) return;
      if (exitingRef.current) return; // our own exit (keydown path / teardown)
      if (panelRef.current) {
        setPanel(null);
        return;
      }
      if (downloadOpenRef.current) {
        setDownloadOpen(false);
        return;
      }
      exitingRef.current = true;
      onBackRef.current();
    };
    document.addEventListener("fullscreenchange", onFsChange);
    // Safari < 16.4 fires only the webkit-prefixed event — without this the
    // first Esc there silently drops fullscreen and exit needs a second press
    document.addEventListener("webkitfullscreenchange", onFsChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
    };
  }, []);

  const total = anime.totalEpisodes || episode;
  // touch devices have their own auto-fullscreen + rotation flow — the manual
  // Full screen control is a desktop affordance
  const coarsePointer = typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)")?.matches;
  // Settings screen preferences — read reactively where the render needs them
  // (subtitle cues are native tracks styled via the document ::cue rule), and
  // through a ref inside long-lived event listeners (ended -> autoplay next)
  // so flipping a switch never has to re-bind the player's media handlers.
  const appSettings = useAppSettings();
  const appSettingsRef = useRef(appSettings);
  appSettingsRef.current = appSettings;
  const downloadUrl = zokoDownloadUrl(anime.malId, episode, lang);

  /* -------- Chromecast: load the CAF sender SDK + track session state -------- */
  useEffect(() => {
    ensureCastSdk();
    setCastState(getCastState());
    const off = onCastStateChange((s) => {
      castStateRef.current = s;
      setCastState(s);
    });
    return off;
  }, []);

  /* -------- casting = the TV is the only screen and speaker. The moment a
     session goes live, pause the local video — this also closes the race
     where the element started playing while the device chooser was open. -------- */
  useEffect(() => {
    if (castState === "casting") videoRef.current?.pause();
  }, [castState]);

  /* -------- receiver-side playback failures surface as a player toast -------- */
  useEffect(() => {
    let timer: number | null = null;
    const off = onCastMediaError((msg) => {
      setCastMsg(msg);
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => setCastMsg(null), 12_000);
    });
    return () => {
      if (timer) window.clearTimeout(timer);
      off();
    };
  }, []);

  /* -------- figure out where to resume (local first, server fallback) -------- */
  useEffect(() => {
    let cancelled = false;
    resumeAtRef.current = 0;
    setResumedFrom(null);

    const apply = (pos: number, dur: number) => {
      if (cancelled) return;
      // only resume when it makes sense: >15s in, and not effectively finished
      if (pos >= 15 && (dur <= 0 || pos < dur * 0.95)) {
        resumeAtRef.current = pos;
        setResumedFrom(pos);
        // if playback already started (server answer arrived late), jump now
        const v = videoRef.current;
        if (v && v.currentTime < 5 && !iframeFallback) v.currentTime = pos;
      }
    };

    const local = getEpProgress(anime.malId, episode);
    if (local && local.pos >= 15) apply(local.pos, local.dur);
    else {
      fetchServerProgress(anime.malId).then((map) => {
        const e = map[String(episode)];
        if (e && e.pos >= 15) apply(e.pos, e.dur);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [anime.malId, episode, lang, server, iframeFallback]);

  // auto-hide the "Resumed" pill
  useEffect(() => {
    if (resumedFrom == null) return;
    const t = window.setTimeout(() => setResumedFrom(null), 9000);
    return () => window.clearTimeout(t);
  }, [resumedFrom]);

  /* -------- keep the "last watched" marker fresh for Details badges -------- */
  useEffect(() => {
    setProgress(anime.malId, episode, lang);
  }, [anime.malId, episode, lang]);

  /* -------- deliberate playback lifts a removal tombstone --------
     The viewer opened this anime to watch it — if they had removed it from
     Continue Watching earlier, tracking resumes from now (the tombstone
     existed to keep stale saves from resurrecting a deleted entry). */
  useEffect(() => {
    clearProgressTombstone(anime.malId);
  }, [anime.malId]);

  /* -------- resolve the direct stream -------- */
  useEffect(() => {
    // the exit-animation copy of this view must not fire network effects
    if (shellRef.current?.closest('[data-leaving="true"]')) return;
    // OFFLINE FALLBACK (plays-a-minute-then-buffers / next-episode-while-
    // offline): when offline, the SW-cached /api/stream resolve carries a
    // STALE tokenized src (Zoko rotates tokens on every fresh resolve) whose
    // segments are not in the media cache. The saved registry's playlist URL
    // is the EXACT url that was downloaded — that is the only playable src.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      const saved = getSavedEpisode(`${anime.malId}:${episode}:${lang}:${server}`);
      if (saved) {
        setStream({ src: saved.url, subtitles: [], skip: undefined, referer: null, pk: null });
        setReady(false);
        return;
      }
    }
    // a staged seek is only valid for the episode it was staged on — without
    // this guard a failed SUB↔DUB toggle left the spot staged and pressing
    // Next resumed the NEW episode at the OLD episode's position
    if (stagedForRef.current && stagedForRef.current !== `${anime.malId}:${episode}`) {
      pendingSeekRef.current = null;
      stagedForRef.current = "";
    }
    let cancelled = false;
    setStream(null);
    setStreamError(false);
    setReady(false);
    setCurrentTime(0);
    setDuration(0);
    (async () => {
      try {
        const res = await fetch(`/api/stream?malId=${anime.malId}&ep=${episode}&lang=${lang}&server=${server}`);
        if (!res.ok) {
          // Resolve failure on one language auto-falls back to the other
          // (dub->sub AND sub->dub — Pokémon-class titles are DUB-ONLY and
          // their sub pages are shells), guarded to ONE fallback per episode
          // so a both-sides-dead title can't ping-pong forever.
          const guardKey = `${anime.malId}:${episode}`;
          if (fallbackTriedRef.current !== guardKey) {
            fallbackTriedRef.current = guardKey;
            if (lang === "dub") {
              showPlayerMsg("No English DUB available for this episode yet — playing SUB", 8_000);
              setLang("sub");
              return;
            }
            if (lang === "sub" && ((dubServers?.length ?? 0) > 0 || (backupDub?.length ?? 0) > 0)) {
              showPlayerMsg("No SUB available for this title — DUB only", 8_000);
              setLang("dub");
              return;
            }
          }
          throw new Error("unavailable");
        }
        const data = (await res.json()) as Resolved;
        // a 200-with-no-src payload used to build `u=undefined` playlists and
        // strand the player on a black spinner forever — treat it as a failure
        if (!data || typeof data.src !== "string" || !data.src) throw new Error("bad-payload");
        if (!cancelled) {
          setStream({ src: data.src, subtitles: data.subtitles ?? [], skip: data.skip, referer: data.referer ?? null, pk: data.pk ?? null, heights: Array.isArray(data.heights) ? data.heights : undefined });
          // the DUB backfill sources (SupaPlay / yenime / the Anivexa backup
          // network) kick in when neither Zoko nor Kiwi carries a real dub —
          // say so, it explains any minor differences (sub style, quality ladder)
          if (lang === "dub" && data.provider) {
            if (data.provider === "yenime" || data.provider === "supaplay") {
              showPlayerMsg(
                data.provider === "yenime"
                  ? "English DUB via Yenime — Zoko/Kiwi had none"
                  : "English DUB via SupaPlay — Zoko/Kiwi had none",
                5_000,
              );
            } else if (data.provider === "flix") {
              showPlayerMsg("English DUB via FlixCloud — dual-audio source", 5_000);
            } else if (data.provider.startsWith("anivexa-")) {
              const nm = data.providerName || data.provider.slice("anivexa-".length);
              showPlayerMsg(`English DUB via ${nm} (backup server) — Zoko/Kiwi had none`, 6_000);
            }
          }
          // absolute public URL the Chromecast receiver can fetch through our proxy
          const isProxied = data.src.startsWith("/api/");
          const isHls = /\.m3u8($|\?|%3f)/i.test(data.src) || isProxied;
          castMediaUrlRef.current = isProxied
            ? `${window.location.origin}${data.src}`
            : `${window.location.origin}/api/stream/proxy?type=${isHls ? "m3u8" : "seg"}&u=${encodeURIComponent(data.src)}${data.referer ? `&rf=${encodeURIComponent(data.referer)}` : ""}${data.pk ? `&pk=${encodeURIComponent(data.pk)}` : ""}`;
        }
      } catch {
        if (!cancelled) setStreamError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [anime.malId, episode, lang, server]);

  /* -------- persist watch progress (heartbeat / pause / exit / ended) --------
     EXIT-FLUSH TRAP (fixed): React detaches JSX refs (videoRef.current = null)
     BEFORE unmount effect cleanups run, so the old "flush on unmount" read
     videoRef.current === null and silently dropped the save — seek + exit
     immediately = the CW bar stayed at the last 10s heartbeat. lastPosRef /
     lastDurRef are plain refs (never attached to JSX, never detached) and are
     synced on every timeupdate and every seek, so the exit flush always has
     the exact second you left at. */
  const lastPosRef = useRef(0);
  const lastDurRef = useRef(0);
  const saveNow = useCallback(
    (opts?: { keepalive?: boolean; completed?: boolean }) => {
      if (iframeFallback) return;
      const v = videoRef.current;
      const pos = v ? v.currentTime : lastPosRef.current;
      const dur = (v && v.duration) || lastDurRef.current || 0;
      if (!pos && !opts?.completed) return; // nothing ever played
      saveProgressDetailed(
        {
          malId: anime.malId,
          episode,
          lang,
          server,
          position: pos,
          duration: dur,
          completed: opts?.completed,
          title: anime.title,
          image: anime.image,
          total: anime.totalEpisodes || episode,
        },
        opts,
      );
    },
    [anime.malId, anime.title, anime.image, anime.totalEpisodes, episode, lang, server, iframeFallback],
  );

  useEffect(() => {
    const id = window.setInterval(() => {
      const v = videoRef.current;
      if (v && !v.paused && !v.ended) saveNow();
    }, 10_000);

    const onHide = () => {
      if (document.visibilityState === "hidden") saveNow({ keepalive: true });
    };

    // (watch-time accrual lives in its own effect below)
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.clearInterval(id);
      saveNow({ keepalive: true });
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [saveNow]);

  /* -------- watch-time accrual (Top 10 Today) --------
     Counts ONLY real viewing: the video must actually be playing. Paused,
     ended and iframe-fallback time never accrues, and the clock advances on
     every tick, so a pause followed by a long idle adds nothing when playback
     resumes. Deltas land in the per-day per-anime ranking bucket (flushed
     every 10s, on tab hide, and when leaving the player). */
  useEffect(() => {
    const flush = (keepalive?: boolean) => {
      const v = videoRef.current;
      const now = Date.now();
      if (v && !v.paused && !v.ended && !iframeFallback) {
        const delta = (now - lastActiveRef.current) / 1000;
        if (delta >= 1) {
          recordWatchSeconds({ malId: anime.malId, title: anime.title, image: anime.image, delta }, { keepalive });
        }
      }
      lastActiveRef.current = now;
    };
    const id = window.setInterval(flush, 10_000);
    const onHide = () => {
      if (document.visibilityState === "hidden") flush(true);
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.clearInterval(id);
      flush(true);
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [anime.malId, anime.title, anime.image, iframeFallback]);

  /* -------- cast progress heartbeat (positions come from the TV) -------- */
  useEffect(() => {
    if (castState !== "casting") return;
    let lastPos: number | null = castPosition();
    let castActiveAt = Date.now();
    const id = window.setInterval(() => {
      const pos = castPosition();
      const now = Date.now();
      const delta = Math.min(120, (now - castActiveAt) / 1000);
      if (pos == null || pos === lastPos) {
        // TV paused or unreachable — wall time between these ticks doesn't count
        lastPos = pos;
        castActiveAt = now;
        return;
      }
      lastPos = pos;
      castActiveAt = now;
      if (delta >= 1) {
        recordWatchSeconds({ malId: anime.malId, title: anime.title, image: anime.image, delta });
      }
      saveProgressDetailed({
        malId: anime.malId,
        episode,
        lang,
        server,
        position: pos,
        duration: castDuration() || 0,
        title: anime.title,
        image: anime.image,
        total: anime.totalEpisodes || episode,
      });
    }, 10_000);
    return () => {
      window.clearInterval(id);
      // flush any residual playing time since the last tick
      const delta = Math.min(120, (Date.now() - castActiveAt) / 1000);
      const pos = castPosition();
      if (delta >= 1 && pos != null && pos !== lastPos) {
        recordWatchSeconds({ malId: anime.malId, title: anime.title, image: anime.image, delta });
      }
    };
  }, [castState, anime.malId, anime.title, anime.image, anime.totalEpisodes, episode, lang, server]);

  /* -------- cast remote: position/duration/playing straight from the TV.
     Polled 2×/s — fast enough for a smooth-feeling bar (the receiver
     interpolates via getEstimatedTime), cheap enough to ignore. -------- */
  const [castUi, setCastUi] = useState({ pos: 0, dur: 0, playing: false });
  // while the user drags the bar, their finger wins over the poll
  const [castScrub, setCastScrub] = useState<number | null>(null);
  useEffect(() => {
    if (castState !== "casting") {
      setCastScrub(null);
      return;
    }
    const tick = () =>
      setCastUi({ pos: castPosition() ?? 0, dur: castDuration() ?? 0, playing: castIsPlaying() });
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [castState, episode]); // episode: reset the readout the moment the TV loads the next one

  const castToggle = () => {
    // optimistic flip — the poll corrects us if the command failed
    setCastUi((u) => ({ ...u, playing: !u.playing }));
    void castTogglePlay();
  };

  const castSkip = (delta: number) => {
    let target = (castScrub ?? castUi.pos) + delta;
    if (castUi.dur > 0) target = Math.min(castUi.dur, target);
    target = Math.max(0, target);
    setCastUi((u) => ({ ...u, pos: target }));
    void castSeek(target);
  };

  const commitCastScrub = () => {
    setCastScrub((v) => {
      if (v != null) void castSeek(v);
      return null;
    });
  };

  /* -------- attach hls.js -------- */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream || iframeFallback) return;
    let destroyed = false;

    setLevels([]);
    setQuality("auto");

    const startPlayback = () => {
      if (destroyed) return;
      setReady(true);

      // casting already? hand this episode straight to the TV, keep phone quiet
      if (castStateRef.current === "casting") {
        const cap = pickSubtitleTrack(stream.subtitles);
        void castLoadNext({
          src: castMediaUrlRef.current,
          title: castTitleRef.current,
          imageUrl: anime.image,
          startTime: pendingSeekRef.current ?? resumeAtRef.current,
          captions: cap ? { url: `${window.location.origin}/api/stream/proxy?type=vtt&u=${encodeURIComponent(cap.src)}`, label: cap.label || "English" } : undefined,
        }).then((ok2) => {
          if (!ok2) {
            setCastMsg("Couldn't load this episode on the TV — Stop casting, then cast again");
            trackToastTimer(window.setTimeout(() => setCastMsg(null), 12_000));
          }
        });
        pendingSeekRef.current = null;
        return;
      }

      // mid-play source switch (quality-server change) resumes exactly where
      // the user was; otherwise fall back to the saved resume point
      const target = pendingSeekRef.current ?? resumeAtRef.current;
      pendingSeekRef.current = null;
      if (target > 0 && Math.abs(video.currentTime - target) > 0.5) {
        video.currentTime = target;
      }
      video.play().catch(() => undefined);
    };

    if (stream.src && !/\.m3u8($|\?)/i.test(stream.src)) {
      // progressive source (SupaPlay DUB backfill ships signed MP4s) —
      // hls.js can't take these; the native video element plays them directly
      setLevels([]);
      video.src = proxyUrl(stream.src, "seg", stream.referer);
      video.addEventListener("loadedmetadata", startPlayback, { once: true });
    } else if (Hls.isSupported()) {
      const hls = new Hls({
        // startup quality floor: assume a 4 Mbps link so the opening seconds
        // play at high quality instead of crawling up from 360p
        abrEwmaDefaultEstimate: 4_000_000,
        // deeper buffer = fewer proxy round-trips; 60s of back-buffer keeps
        // rewinds inside the browser cache
        maxBufferLength: 60,
        backBufferLength: 60,
        // fetch the first fragment while the manifest is still parsing
        startFragPrefetch: true,
      });
      hlsRef.current = hls;
      let netRetries = 0; // fatal-network recoveries before we give up honestly
      let mediaRetries = 0; // fatal-media recoveries before the honest Retry UI
      hls.loadSource(proxyUrl(stream.src, "m3u8", stream.referer, stream.pk));
      hls.attachMedia(video);
      // dual-audio masters (the FlixCloud dub embeds carry Japanese + English
      // tracks with Japanese flagged default): lang=dub must actually SPEAK
      // English, so flip to the English track the moment hls enumerates them
      const pickDubAudio = () => {
        if (lang !== "dub") return;
        const tracks = hls.audioTracks ?? [];
        const idx = tracks.findIndex((t) => /eng/i.test(`${t.lang ?? ""} ${t.name ?? ""}`));
        if (idx >= 0 && hls.audioTrack !== idx) hls.audioTrack = idx;
      };
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, pickDubAudio);
      hls.on(Hls.Events.MANIFEST_PARSED, pickDubAudio);
      hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        setLevels(data.levels ?? []);
        startPlayback();
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          // unbounded startLoad() loops spun forever on dead manifests — cap
          // the recoveries, then surface the honest Retry UI
          netRetries += 1;
          if (netRetries > 5 || typeof navigator !== "undefined" && !navigator.onLine) {
            hls.stopLoad();
            if (!destroyed) setStreamError(true);
            return;
          }
          hls.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          // recoverMediaError() loops spun forever on a corrupt rendition —
          // cap it, then surface the honest Retry UI like the network path
          mediaRetries += 1;
          if (mediaRetries > 3) {
            hls.stopLoad();
            if (!destroyed) setStreamError(true);
            return;
          }
          hls.recoverMediaError();
        } else if (!destroyed) {
          setStreamError(true);
        }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari native HLS
      video.src = proxyUrl(stream.src, "m3u8", stream.referer, stream.pk);
      video.addEventListener("loadedmetadata", startPlayback, { once: true });
    } else if (!destroyed) {
      setStreamError(true);
    }

    return () => {
      destroyed = true;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      video.removeAttribute("src");
      video.load();
    };
  }, [stream, iframeFallback]);

  /* -------- video element events -------- */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => {
      lastPosRef.current = video.currentTime; // exit-flush source of truth
      setCurrentTime(video.currentTime);
      if (video.buffered.length) setBuffered(video.buffered.end(video.buffered.length - 1));
    };
    const onMeta = () => {
      if (video.duration) lastDurRef.current = video.duration;
      setDuration(video.duration || 0);
    };
    const onPlay = () => {
      // mid-cast the TV owns playback — any stray local play() (stale
      // gesture promise, hls restart, double-tap) is silenced immediately
      if (castStateRef.current === "casting") {
        video.pause();
        return;
      }
      setPlaying(true);
      lastActiveRef.current = Date.now(); // playback resumed — start the clock
    };
    const onPause = () => {
      setPlaying(false);
      lastActiveRef.current = Date.now(); // paused — don't count idle time
      // 'ended' also fires 'pause' — the completed save belongs to onEnded
      // alone (double-POSTing the same row was benign but chatty)
      if (!video.ended) saveNow();
    };
    const onEnded = () => {
      setPlaying(false);
      lastActiveRef.current = Date.now();
      saveNow({ completed: true });
      // Settings -> "Autoplay next episode": roll straight into the next one.
      // episode/lang/stream all move together (each change re-fetches the
      // stream, which re-runs this effect), so the closure is fresh here.
      if (appSettingsRef.current.autoNext && episode < total) onEpisodeChange(episode + 1, lang, server);
    };
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("progress", onTime);
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("durationchange", onMeta);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    return () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("progress", onTime);
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("durationchange", onMeta);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
    };
  }, [stream, iframeFallback, saveNow]);

  /* -------- next-episode pre-resolve --------
     While THIS episode plays, quietly resolve the next one 15s in. The
     /api/stream resolution (upstream scrape + dub checks + skip data) is
     cached server-side, so the warm request is a no-op upstream — and
     tapping "Next episode" starts playing almost instantly instead of
     staring at the spinner through a cold resolve. */
  useEffect(() => {
    if (!ready || iframeFallback || episode >= total) return;
    const t = window.setTimeout(() => {
      fetch(`/api/stream?malId=${anime.malId}&ep=${episode + 1}&lang=${lang}&server=${server}`)
        .then(() => undefined)
        .catch(() => undefined);
    }, 15_000);
    return () => window.clearTimeout(t);
  }, [ready, iframeFallback, anime.malId, episode, total, lang, server]);

  /* -------- offline save: download this episode (then the next one) --------
     Watching online only caches a ~60s rolling buffer, so offline playback
     used to stall at the end of it ("plays a good minute then buffers").
     While online, walk the whole HLS tree through the proxy so the SW
     stashes every byte — chosen quality's segments in order, dual-audio
     renditions, AES keys, subtitles — then resolve + save the NEXT episode
     too (its /api/stream answer doubles as the SW's API-cache warm, so the
     offline next-episode tap resolves from the cache and just plays).
     Everything runs in a module singleton: navigating away never interrupts
     a download, and re-runs only fetch segments the SW doesn't have yet. */
  const saveKey = `${anime.malId}:${episode}:${lang}:${server}`;
  useEffect(() => {
    if (!ready || !stream || iframeFallback || offline) return;
    const isHls = /\.m3u8($|\?)/i.test(stream.src) || stream.src.startsWith("/api/");
    enqueueEpisodeSave({
      key: saveKey,
      playlistUrl: proxyUrl(stream.src, isHls ? "m3u8" : "seg", stream.referer, stream.pk),
      subtitles: (stream.subtitles ?? []).slice(0, 2).map((s) => proxyUrl(s.src, "vtt")),
      onProgress: (s) => setSaveState(s),
      resolveNext:
        episode < total
          ? async () => {
              const res = await fetch(
                `/api/stream?malId=${anime.malId}&ep=${episode + 1}&lang=${lang}&server=${server}`,
              );
              if (!res.ok) return null;
              const d = (await res.json()) as Resolved;
              if (!d?.src) return null;
              const nextHls = /\.m3u8($|\?)/i.test(d.src) || d.src.startsWith("/api/");
              return {
                key: `${anime.malId}:${episode + 1}:${lang}:${server}`,
                playlistUrl: proxyUrl(d.src, nextHls ? "m3u8" : "seg", d.referer, d.pk),
                subtitles: (d.subtitles ?? []).slice(0, 2).map((s) => proxyUrl(s.src, "vtt")),
              };
            }
          : undefined,
    });
  }, [ready, stream, iframeFallback, offline, saveKey, episode, total, anime.malId, lang, server]);

  // the "Saved for offline ✓" pill clears itself a few seconds after landing
  // (and a failed save's hidden error state clears itself too)
  useEffect(() => {
    if (saveState?.phase !== "done" && saveState?.phase !== "error") return;
    const t = window.setTimeout(() => setSaveState(null), saveState.phase === "error" ? 4_000 : 5_000);
    return () => window.clearTimeout(t);
  }, [saveState]);

  const go = useCallback((ep: number) => {
    if (ep >= 1 && ep <= total) onEpisodeChange(ep, lang, server);
  }, [total, onEpisodeChange, lang, server]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video || castStateRef.current === "casting") return;
    if (video.paused) video.play().catch(() => undefined);
    else video.pause();
  };

  const seekTo = (s: number) => {
    const video = videoRef.current;
    if (!video || castStateRef.current === "casting") return;
    // durationRef (not the stale closure's `duration`) — the keydown handler
    // bound this function once, before any metadata ever arrived
    video.currentTime = Math.max(0, Math.min(durationRef.current || s, s));
    lastPosRef.current = video.currentTime; // seek + instant exit must still save HERE
    setCurrentTime(video.currentTime);
  };

  // Crowd-learned Skip Intro: when a viewer manually scrubs forward from
  // inside the intro region well past it, that target is the best possible
  // hint where the OP ends on shows with no skip data (new seasons).
  // Throttled to one vote/minute; the server validates + takes medians.
  const lastSkipVoteRef = useRef(0);
  const userScrub = (to: number) => {
    const from = scrub ?? currentTime;
    setScrub(to); // visual only — the seek itself commits on release
    try {
      const now = Date.now();
      if (now - lastSkipVoteRef.current < 60_000) return;
      if (from >= 8 && from <= 240 && Number.isFinite(to) && to >= from + 15 && to <= 420) {
        lastSkipVoteRef.current = now;
        fetch("/api/skip-vote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ malId: anime.malId, ep: episode, target: to }),
          keepalive: true,
        }).catch(() => undefined);
      }
    } catch {
      /* voting is cosmetic */
    }
  };

  const applyQuality = (q: "auto" | number) => {
    setQuality(q);
    // save the spot immediately so nothing (network blip, app kill) can lose
    // it across the switch — hls.currentLevel changes are seamless and do
    // NOT restart playback
    saveNow();
    if (hlsRef.current) hlsRef.current.currentLevel = q === "auto" ? -1 : q;
  };

  /** Save the current spot so an upcoming stream swap resumes EXACTLY here
   *  (SUB↔DUB toggles and backup-server jumps re-resolve the source; without
   *  staging the pending seek they used to rewind 10–20s to the last 10s
   *  heartbeat — every language switch felt like a restart). */
  const stageSpot = () => {
    const pos = videoRef.current?.currentTime ?? 0;
    saveNow();
    pendingSeekRef.current = pos;
    stagedForRef.current = `${anime.malId}:${episode}`;
  };

  /** Switch stream server mid-playback without losing the spot. */
  const switchServer = (next: ServerId) => {
    if (next === server || castStateRef.current === "casting") return;
    stageSpot();
    setPanel(null);
    // backup servers are DUB only — switching to one flips the language too
    onEpisodeChange(episode, isBackupServer(next) ? "dub" : lang, next);
  };

  const applySpeed = (s: number) => {
    setSpeed(s);
    if (videoRef.current) videoRef.current.playbackRate = s;
  };

  const toggleSubs = (on: boolean) => {
    setSubsOn(on);
    const video = videoRef.current;
    if (!video) return;
    for (const t of Array.from(video.textTracks)) t.mode = on ? "showing" : "hidden";
  };

  /** Pick a caption language from the subs panel (all tracks the source carries). */
  const pickSubLang = (i: number) => {
    setSubIdx(i);
    setSubsOn(true);
    const video = videoRef.current;
    if (!video) return;
    // the <track> element remounts with the new src (key=src); mark it showing
    // right away so the swap is instant (the element also carries `default`)
    for (const t of Array.from(video.textTracks)) t.mode = "showing";
  };

  const fullscreen = () => {
    const el = shellRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      // OUR exit — the fullscreenchange bridge must not read it as Esc
      exitingRef.current = true;
      document.exitFullscreen().catch(() => undefined);
    } else {
      const fel = el as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
      const request = el.requestFullscreen?.bind(el) ?? fel.webkitRequestFullscreen?.bind(el);
      try {
        void request?.()?.catch?.(() => undefined);
      } catch {
        /* iPhone Safari element-fullscreen — ignore */
      }
    }
  };

  /* -------- Chromecast actions -------- */
  const startCasting = async () => {
    if (!stream) return;
    // the TV is about to own playback — silence THIS device right away so
    // audio/video never double-plays during chooser + session negotiation
    videoRef.current?.pause();
    const res = await castLoad({
      src: castMediaUrlRef.current,
      title: castTitle,
      imageUrl: anime.image,
      startTime: videoRef.current ? videoRef.current.currentTime : resumeAtRef.current,
      captions: subTrack
        ? { url: `${window.location.origin}/api/stream/proxy?type=vtt&u=${encodeURIComponent(subTrack.src)}`, label: subTrack.label || "English" }
        : undefined,
    });
    if (res.ok) {
      videoRef.current?.pause();
      setCastMsg(null);
    } else {
      setCastMsg(res.error ?? "Cast failed");
      window.setTimeout(() => setCastMsg(null), 12_000);
    }
  };

  const stopCasting = () => {
    // save the TV's position before handing playback back
    const pos = castPosition();
    const dur = castDuration();
    if (pos != null) {
      saveProgressDetailed({
        malId: anime.malId, episode, lang, server,
        position: pos, duration: dur || 0,
        title: anime.title, image: anime.image, total: anime.totalEpisodes || episode,
      });
      // hand playback back to this device at the exact second the TV was at
      const v = videoRef.current;
      if (v && pos > 0) v.currentTime = pos;
    }
    castStop();
  };

  // Skip buttons — REAL data only. The interval comes from the merged
  // server-side tiers (fleet-scouted measurements on our own encodes → Zoko
  // payload → AniSkip → crowd-learned scrub medians — see /api/stream). The
  // old blind 8-90s guess is GONE: when nothing measured this episode, the
  // button would land mid-cold-open and skip dialogue — no data, no button.
  const introSkip: { start: number; end: number } | undefined = stream?.skip?.intro;
  const outroSkip = stream?.skip?.outro;
  // Pressed-this-appearance flags: the skip lands INSIDE the window (3 s
  // before the OP ends), so currentTime-derived visibility alone keeps the
  // button on screen through the seek latency AND the remaining window —
  // the owner reported it "stays like a second longer". Once tapped, the
  // button must vanish INSTANTLY: the flags suppress it until playback
  // leaves the window (seeking back re-arms it for a fresh appearance).
  const [skipIntroDismissed, setSkipIntroDismissed] = useState(false);
  const [skipOutroDismissed, setSkipOutroDismissed] = useState(false);
  // pop up the MOMENT the opening starts — a 1 s lead absorbs timeupdate
  // granularity so the button is already on screen as the OP appears
  const showSkipIntro = Boolean(introSkip && !skipIntroDismissed && currentTime >= introSkip.start - 1 && currentTime <= introSkip.end && !locked);
  const showSkipOutro = Boolean(outroSkip && !skipOutroDismissed && currentTime >= outroSkip.start && currentTime <= outroSkip.end && !locked);
  // leaving the window re-arms the buttons (also covers episode switches —
  // currentTime resets outside any window)
  useEffect(() => {
    const insideIntro = Boolean(introSkip && currentTime >= introSkip.start - 1 && currentTime <= introSkip.end);
    if (!insideIntro) setSkipIntroDismissed(false);
    const insideOutro = Boolean(outroSkip && currentTime >= outroSkip.start && currentTime <= outroSkip.end);
    if (!insideOutro) setSkipOutroDismissed(false);
  }, [currentTime, introSkip, outroSkip]);

  // Settings -> "Auto-skip intro / ending": same REAL skip data the buttons
  // use — no data, no auto-jump (a blind guess would skip dialogue). Fires
  // once per region appearance (keyed by episode + region + start) so a seek
  // back into the OP doesn't yo-yo the viewer forward again. Cast state is
  // read through the ref (declared with the player hooks, well above) so the
  // effect can sit beside the skip-window derivations.
  const autoSkipKeyRef = useRef("");
  useEffect(() => {
    if (castStateRef.current === "casting" || iframeFallback) return;
    if (appSettings.autoSkipIntro && showSkipIntro && introSkip) {
      const key = `i:${episode}:${introSkip.start}`;
      if (autoSkipKeyRef.current !== key) {
        autoSkipKeyRef.current = key;
        seekTo(Math.max(introSkip.start, introSkip.end - 3));
      }
    } else if (appSettings.autoSkipOutro && showSkipOutro && outroSkip) {
      const key = `o:${episode}:${outroSkip.start}`;
      if (autoSkipKeyRef.current !== key) {
        autoSkipKeyRef.current = key;
        seekTo(outroSkip.end);
      }
    }
  }, [appSettings.autoSkipIntro, appSettings.autoSkipOutro, showSkipIntro, showSkipOutro, introSkip, outroSkip, episode, iframeFallback]);
  // Zoko tags EVERY subtitle track lang:"en" and often lists English NOT first
  // (FMA:B ep1: Arabic, Chinese, Chinese, Danish, Dutch, English, ...) — pick
  // the real English track instead of blindly playing subtitles[0]. A manual
  // pick from the subs panel (subIdx) wins over the auto choice.
  const subTrack =
    subIdx != null && stream?.subtitles?.[subIdx]
      ? stream.subtitles[subIdx]
      : pickSubtitleTrack(stream?.subtitles);
  // a new source (episode/server switch) carries its own track list — drop
  // the manual language pick so the English default re-applies
  useEffect(() => {
    setSubIdx(null);
  }, [stream]);

  // CC-SYNC FLEET: a provider's caption track can lag (or lead) the dub
  // audio — Soul Eater's dub CC ran seconds late. The cc-sync bots measure
  // the exact drift per episode (DSP cross-correlation of caption activity
  // vs the voice-band loudness envelope, several windows per episode) and
  // store two terms:
  //   offsetMs      a CONSTANT lag (per-encode leading trim)
  //   driftMsPerMin a LINEAR term — captions gain this many ms per playback
  //                 minute (the dub audio runs at a different effective speed
  //                 than the sub-timed track; skew GROWS through the episode,
  //                 which is exactly the "captions vanish while they talk,
  //                 come back later, sometimes never" report)
  // Here we fetch the verdict for THIS episode and remap every cue with
  //   t' = t·(1 - driftPerSec) - offsetSec
  // (positive offset/drift = captions late → cues move earlier). Below the
  // gates the drift is imperceptible, so untouched playback wins.
  const ccOffsetRef = useRef(0);
  const ccDriftRef = useRef(0); // fraction of playback time gained per second
  useEffect(() => {
    let ok = true;
    ccOffsetRef.current = 0;
    ccDriftRef.current = 0;
    if (offline || iframeFallback) return; // offline copies / iframe embeds carry their own timing
    // the exit-animation copy must not fire network effects
    if (shellRef.current?.closest('[data-leaving="true"]')) return;
    fetch(`/api/captions?malId=${anime.malId}&ep=${episode}&lang=${lang}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { measured?: boolean; offsetMs?: number; driftMsPerMin?: number; fitR2?: number; confidence?: number } | null) => {
        if (!ok || !d?.measured) return;
        const offMs = typeof d.offsetMs === "number" ? d.offsetMs : 0;
        const driftMs = typeof d.driftMsPerMin === "number" ? d.driftMsPerMin : 0;
        const fitR2 = typeof d.fitR2 === "number" ? d.fitR2 : 0;
        // the linear term only counts when the fit actually supports it
        const useDrift = Math.abs(driftMs) >= 500 && fitR2 >= 0.4;
        if (Math.abs(offMs) < 250 && !useDrift) return;
        if ((d.confidence ?? 0) < 0.4) return;
        ccOffsetRef.current = offMs / 1000;
        ccDriftRef.current = useDrift ? driftMs / 60_000 : 0;
        const parts: string[] = [];
        if (Math.abs(offMs) >= 250) {
          const s = offMs > 0 ? `-${(offMs / 1000).toFixed(1)}s` : `+${(-offMs / 1000).toFixed(1)}s`;
          parts.push(s);
        }
        if (useDrift) {
          const s = driftMs > 0 ? `-${(driftMs / 1000).toFixed(1)}s/min` : `+${(-driftMs / 1000).toFixed(1)}s/min`;
          parts.push(s);
        }
        const msg = `Captions auto-synced (${parts.join(" ")})`;
        setPlayerMsg(msg);
        trackToastTimer(window.setTimeout(() => setPlayerMsg((m) => (m === msg ? null : m)), 5_000));
      })
      .catch(() => undefined);
    return () => {
      ok = false;
    };
    // stream?.src re-arms on episode/server switches (an episode can re-resolve)
  }, [anime.malId, episode, lang, stream?.src, offline, iframeFallback]);

  // Apply the drift to the native text tracks: VTTCue objects materialize
  // when the browser parses the <track>'s VTT, so poll briefly and remap
  // every cue not yet marked. Cue objects are per-track-instance — a caption
  // language switch or episode change brings fresh unmarked cues, and this
  // effect re-runs with the new track's src.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const t0 = Date.now();
    const iv = window.setInterval(() => {
      const off = ccOffsetRef.current;
      const dps = ccDriftRef.current; // per-second drift fraction
      if (!off && !dps) return;
      const remap = (u: number) => u * (1 - dps) - off;
      let touched = false;
      for (const track of Array.from(video.textTracks)) {
        if (track.mode === "disabled") continue;
        const cues = track.cues;
        if (!cues) continue;
        for (let i = 0; i < cues.length; i++) {
          const cue = cues[i] as VTTCue & { __ccsync?: boolean };
          if (cue.__ccsync) continue;
          const ns = Math.max(0, remap(cue.startTime));
          cue.startTime = ns;
          cue.endTime = Math.max(ns + 0.05, remap(cue.endTime));
          cue.__ccsync = true;
          touched = true;
        }
      }
      // settle once every loaded track has been shifted (or give up after 45s)
      if ((touched && Date.now() - t0 > 4_000) || Date.now() - t0 > 45_000) window.clearInterval(iv);
    }, 600);
    return () => window.clearInterval(iv);
  }, [subTrack?.src, subsOn, stream?.src]);

  const pct = duration > 0 ? ((scrub ?? currentTime) / duration) * 100 : 0;
  const bufPct = duration > 0 ? (buffered / duration) * 100 : 0;
  const casting = castState === "casting";
  const castUsable = castState !== "unavailable";
  const ui = uiVisible; // shorthand for JSX below

  // Skip buttons fade away after 3s untapped; any player-UI summon (tap on
  // the video) brings them straight back while the window is still active.
  const [skipAwake, setSkipAwake] = useState(true);
  const skipFadeTimer = useRef<number | null>(null);
  useEffect(() => {
    const inWindow = Boolean((showSkipIntro || showSkipOutro) && !casting && !iframeFallback);
    if (skipFadeTimer.current) window.clearTimeout(skipFadeTimer.current);
    if (!inWindow) {
      setSkipAwake(true);
      return;
    }
    setSkipAwake(true);
    skipFadeTimer.current = window.setTimeout(() => setSkipAwake(false), 3_000);
    return () => {
      if (skipFadeTimer.current) window.clearTimeout(skipFadeTimer.current);
    };
  }, [showSkipIntro, showSkipOutro, ui, casting, iframeFallback]);

  return (
    <div className="fixed inset-0 z-50 bg-black select-none" ref={shellRef}>
      {/* player surface — full screen; every control is overlaid INSIDE it */}
      <div
        className={`relative w-full h-full flex items-center justify-center overflow-hidden bg-black ${resizeMode === 2 ? "" : "py-2"}`}
        onPointerMove={handlePointerMove}
        onClick={() => {
          // tap the video to show/hide the in-player controls
          if (!playing || panel || locked || streamError) {
            showUi(false);
          } else if (ui) {
            setUiVisible(false);
            if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
          } else {
            showUi();
          }
        }}
      >
        {!iframeFallback ? (
          <>
            <video
              ref={videoRef}
              playsInline
              // AirPlay on iOS Safari (Chromecast is Chrome/Android-only)
              {...({ "x-webkit-airplay": "allow" } as Record<string, string>)}
              poster={artUrl(anime.banner ?? anime.image)}
              className={`w-full h-full border-0 bg-black object-contain ${resizeMode === 1 ? "max-w-[240px] mx-auto" : ""}`}
            >
              {subTrack && subsOn ? (
                <track
                  key={subTrack.src}
                  kind="subtitles"
                  srcLang={subTrack.lang || "en"}
                  label={subTrack.label || "English"}
                  src={proxyUrl(subTrack.src, "vtt", stream?.referer)}
                  default
                />
              ) : null}
            </video>

            {/* brand mark — tiny, see-through, top-left of the picture. It
                rides ABOVE the video surface (fullscreen included) but below
                the control layers, never intercepts taps, and steps aside
                while casting (the TV is the screen then). */}
            <div
              className="pointer-events-none absolute left-3 top-[52px] z-[15] select-none font-slab text-[11px] font-bold tracking-[0.22em] text-white/25 drop-shadow-[0_1px_2px_rgba(0,0,0,0.55)]"
              aria-hidden="true"
            >
              CLYLE
            </div>

            {/* casting overlay — playback lives on the TV now; the phone is
                the remote: play/pause, ±10s, a scrub bar, and next-episode
                (side-loaded into the LIVE session — the TV never disconnects
                between episodes). */}
            {casting ? (
              <div
                className="absolute inset-0 bg-black/90 backdrop-blur-sm flex flex-col z-30"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="shrink-0 flex flex-col items-center gap-2 pt-12 md:pt-14 px-6 text-center">
                  <span className="w-12 h-12 rounded-full bg-[#d32f2f]/15 border border-[#d32f2f]/60 flex items-center justify-center">
                    <Cast className="w-6 h-6 text-[#ff5252]" />
                  </span>
                  <p className="text-[14px] font-bold">Casting to your TV</p>
                  <p className="text-[11.5px] text-gray-400 max-w-[300px] md:max-w-[440px] truncate">
                    {castTitle}
                  </p>
                </div>

                <div className="flex-1" />

                <div className="shrink-0 px-8 pb-10 md:pb-14 flex flex-col items-center gap-6">
                  {/* transport row */}
                  <div className="flex items-center gap-9 md:gap-14">
                    <button
                      onClick={() => castSkip(-10)}
                      className="relative w-12 h-12 md:w-14 md:h-14 flex items-center justify-center active:scale-95 transition"
                      aria-label="Back 10 seconds"
                    >
                      <RotateCcw className="w-7 h-7 md:w-8 md:h-8 text-white drop-shadow-[0_1px_4px_rgba(0,0,0,0.9)]" />
                      <span className="absolute inset-0 flex items-center justify-center text-[8.5px] font-bold text-white pt-1 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)] pointer-events-none">10</span>
                    </button>
                    <button
                      onClick={castToggle}
                      className="w-16 h-16 md:w-20 md:h-20 flex items-center justify-center hover:scale-105 active:scale-95 transition"
                      aria-label={castUi.playing ? "Pause on TV" : "Play on TV"}
                    >
                      {castUi.playing ? (
                        <Pause className="w-9 h-9 md:w-11 md:h-11 text-white fill-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)]" />
                      ) : (
                        <Play className="w-9 h-9 md:w-11 md:h-11 text-white ml-0.5 fill-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)]" />
                      )}
                    </button>
                    <button
                      onClick={() => castSkip(10)}
                      className="relative w-12 h-12 md:w-14 md:h-14 flex items-center justify-center active:scale-95 transition"
                      aria-label="Forward 10 seconds"
                    >
                      <RotateCw className="w-7 h-7 md:w-8 md:h-8 text-white drop-shadow-[0_1px_4px_rgba(0,0,0,0.9)]" />
                      <span className="absolute inset-0 flex items-center justify-center text-[8.5px] font-bold text-white pt-1 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)] pointer-events-none">10</span>
                    </button>
                  </div>

                  {/* progress bar (below the buttons) — scrubbing seeks the TV */}
                  <div className="w-full max-w-[340px] md:max-w-[560px] lg:max-w-[680px] flex items-center gap-2">
                    <span className="text-[10.5px] text-gray-300 tabular-nums w-11 text-right shrink-0">{fmtTime(castScrub ?? castUi.pos)}</span>
                    <div className="relative h-4 flex items-center flex-1">
                      <div className="absolute inset-x-0 h-[3px] bg-white/15 rounded-full">
                        <div
                          className="h-full bg-[#d32f2f] rounded-full"
                          style={{ width: `${castUi.dur > 0 ? ((castScrub ?? castUi.pos) / castUi.dur) * 100 : 0}%` }}
                        />
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={castUi.dur || 0}
                        step={1}
                        value={castScrub ?? Math.min(castUi.pos, castUi.dur || castUi.pos)}
                        onChange={(e) => setCastScrub(parseFloat(e.target.value))}
                        onPointerUp={commitCastScrub}
                        onPointerCancel={() => setCastScrub(null)}
                        onKeyUp={(e) => {
                          if (e.key === "ArrowLeft" || e.key === "ArrowRight") commitCastScrub();
                        }}
                        className="absolute inset-x-0 w-full appearance-none bg-transparent h-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#d32f2f]"
                        aria-label="Seek on TV"
                      />
                    </div>
                    <span className="text-[10.5px] text-gray-300 tabular-nums w-11 shrink-0">{fmtTime(castUi.dur)}</span>
                  </div>

                  {/* next episode — side-loads into the live cast session, so
                      the TV keeps playing without ever disconnecting */}
                  <button
                    onClick={() => go(episode + 1)}
                    disabled={episode >= total}
                    className="flex items-center gap-2 bg-[#d32f2f] hover:bg-[#b71c1c] text-white text-[13px] font-bold rounded-full px-6 py-2.5 transition active:scale-95 disabled:opacity-30"
                  >
                    <SkipForward className="w-4 h-4 fill-white" />
                    Next episode
                  </button>
                  <button
                    onClick={stopCasting}
                    className="text-[12px] font-bold text-gray-400 hover:text-white bg-white/10 hover:bg-white/20 rounded-full px-4 py-1.5 transition active:scale-95"
                  >
                    Stop casting
                  </button>
                </div>
              </div>
            ) : null}

            {/* center transport cluster — [back 10s] [play/pause] [forward 10s],
                like the reference player. The wrapper is pointer-events-none so
                taps between the buttons still fall through to the surface
                (show/hide controls); only the three buttons capture taps. */}
            {ready && !casting && !streamError && !locked ? (
              <div
                className={`absolute inset-0 flex items-center justify-center gap-8 md:gap-14 z-10 player-layer ${ui ? "opacity-100" : "opacity-0 pointer-events-none"}`}
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    seekTo(Math.max(0, currentTime - 10));
                    showUi();
                  }}
                  className="relative w-12 h-12 md:w-14 md:h-14 flex items-center justify-center active:scale-95 transition pointer-events-auto"
                  aria-label="Back 10 seconds"
                >
                  <RotateCcw className="w-7 h-7 md:w-8 md:h-8 text-white drop-shadow-[0_1px_4px_rgba(0,0,0,0.9)]" />
                  <span className="absolute inset-0 flex items-center justify-center text-[8.5px] font-bold text-white pt-1 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)] pointer-events-none">10</span>
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePlay();
                  }}
                  className="w-16 h-16 md:w-20 md:h-20 flex items-center justify-center hover:scale-105 active:scale-95 transition pointer-events-auto"
                  aria-label={playing ? "Pause" : "Play"}
                >
                  {playing ? (
                    <Pause className="w-9 h-9 md:w-11 md:h-11 text-white fill-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)]" />
                  ) : (
                    <Play className="w-9 h-9 md:w-11 md:h-11 text-white ml-0.5 fill-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)]" />
                  )}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    seekTo(Math.min(duration || 0, currentTime + 10));
                    showUi();
                  }}
                  className="relative w-12 h-12 md:w-14 md:h-14 flex items-center justify-center active:scale-95 transition pointer-events-auto"
                  aria-label="Forward 10 seconds"
                >
                  <RotateCw className="w-7 h-7 md:w-8 md:h-8 text-white drop-shadow-[0_1px_4px_rgba(0,0,0,0.9)]" />
                  <span className="absolute inset-0 flex items-center justify-center text-[8.5px] font-bold text-white pt-1 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)] pointer-events-none">10</span>
                </button>
              </div>
            ) : null}

            {/* buffering spinner */}
            {!ready && !streamError && !casting ? (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
                <div className="w-9 h-9 border-2 border-[#d32f2f] border-t-transparent rounded-full animate-spin" />
              </div>
            ) : null}
          </>
        ) : (
          /* hard-sandboxed Zoko iframe fallback (no popups, no top navigation).
             Cross-origin internals can't be recolored, so the fallback gets a
             red-themed frame + our own red chrome around it. */
          <div className={`w-full h-full flex items-center justify-center ${resizeMode === 2 ? "" : "px-2"}`}>
            <div className="relative w-full h-full rounded-md overflow-hidden ring-2 ring-[#d32f2f]/80 shadow-[0_0_24px_rgba(211,47,47,0.35)] bg-black">
              <iframe
                key={`zoko-${episode}-${lang}`}
                src={zokoPlayerUrl(anime.malId, episode, lang)}
                title={castTitle}
                className={`w-full h-full border-0 bg-black ${resizeMode === 1 ? "max-w-[240px] mx-auto" : ""}`}
                allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
                referrerPolicy="no-referrer"
                sandbox="allow-scripts allow-same-origin allow-presentation"
              />
              <div className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-[#d32f2f]/25 to-transparent" />
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-[#d32f2f]/25 to-transparent" />
            </div>
          </div>
        )}

        {/* resumed pill — "picked up where you left off" */}
        {resumedFrom != null && !casting ? (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 bg-black/75 backdrop-blur rounded-full pl-3 pr-1.5 py-1.5 player-layer player-toast-top">
            <span className="text-[11px] text-gray-200 whitespace-nowrap">Resumed at {fmtTime(resumedFrom)}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                seekTo(0);
                setResumedFrom(null);
              }}
              className="text-[11px] font-bold text-[#ff8a80] hover:text-white bg-white/10 hover:bg-[#d32f2f] rounded-full px-2.5 py-1 transition"
            >
              Start over
            </button>
          </div>
        ) : null}

        {/* offline-save pill — "Saving for offline · 43%" → "Saved for offline ✓"
            (the same pill reports the chained NEXT-episode save) */}
        {saveState && !casting && saveState.phase !== "error" ? (
          <div
            className="absolute left-4 z-20 flex items-center gap-2 bg-black/75 backdrop-blur rounded-full px-3 py-1.5 player-layer pointer-events-none"
            style={{ bottom: "7.5rem" }}
          >
            {saveState.phase === "download" ? (
              <>
                <Download className="w-3.5 h-3.5 text-(--app-accent) animate-pulse" />
                <span className="text-[11px] text-gray-200 whitespace-nowrap">
                  {saveState.key === saveKey ? "Saving for offline" : "Saving next episode"}
                  {saveState.total ? ` · ${Math.round((saveState.done / saveState.total) * 100)}%` : ""}
                </span>
              </>
            ) : (
              <>
                <Check className="w-3.5 h-3.5 text-(--app-accent)" />
                <span className="text-[11px] text-gray-200 whitespace-nowrap">
                  {saveState.key === saveKey
                    ? "Saved for offline"
                    : "Next episode saved for offline"}
                </span>
              </>
            )}
          </div>
        ) : null}

        {/* skip intro / skip ending — appear when the window opens, fade out
            after 3s untapped, come back whenever the player UI is summoned */}
        {showSkipOutro && !casting && !iframeFallback ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setSkipOutroDismissed(true); // vanish instantly, don't wait for the seek
              seekTo(outroSkip!.end);
              showUi();
            }}
            className={`absolute bottom-44 md:bottom-48 right-4 flex items-center gap-1.5 bg-black/70 hover:bg-black/85 text-white text-[12.5px] md:text-[14px] font-bold rounded-full px-4 md:px-5 py-2 md:py-2.5 transition-all duration-500 z-10 ${
              skipAwake ? "opacity-100" : "opacity-0 pointer-events-none"
            }`}
          >
            <FastForward className="w-4 h-4 md:w-5 md:h-5 text-(--app-accent)" /> Skip Ending
          </button>
        ) : null}
        {showSkipIntro && !casting && !iframeFallback ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              // vanish INSTANTLY on press (owner report: the button used to
              // linger ~a second because visibility rode on currentTime,
              // which only updates after the seek lands) — then jump to the
              // OP's final seconds (title reveal) instead of hard-cutting out
              setSkipIntroDismissed(true);
              seekTo(Math.max(introSkip!.start, introSkip!.end - 3));
              showUi();
            }}
            className={`absolute bottom-28 md:bottom-32 right-4 flex items-center gap-1.5 bg-black/70 hover:bg-black/85 text-white text-[12.5px] md:text-[14px] font-bold rounded-full px-4 md:px-5 py-2 md:py-2.5 transition-all duration-500 z-10 ${
              skipAwake ? "opacity-100" : "opacity-0 pointer-events-none"
            }`}
          >
            <Zap className="w-4 h-4 md:w-5 md:h-5 text-(--app-accent)" /> Skip Intro
          </button>
        ) : null}

        {/* player toast: cast failures + dub-fallback notices (never both) */}
        {castMsg || playerMsg ? (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 bg-black/80 text-[11.5px] text-gray-200 rounded-2xl px-3.5 py-1.5 max-w-[92%] text-center player-toast-top">
            {castMsg ?? playerMsg}
          </div>
        ) : null}

        {/* desktop ↑/↓ volume OSD — mirrors the keyboard press so the change
            is visible even without a volume slider */}
        {volumePct !== null ? (
          <div className="absolute top-3 right-3 z-30 flex items-center gap-2 bg-black/80 rounded-2xl px-3.5 py-1.5 pointer-events-none player-toast-top">
            <svg viewBox="0 0 24 24" className="w-4 h-4 text-white" fill="currentColor" aria-hidden>
              <path d="M3 9v6h4l5 5V4L7 9H3z" />
              {volumePct > 0 ? (
                <path
                  d={
                    volumePct >= 50
                      ? "M16 8a5 5 0 0 1 0 8M18.5 5.5a9 9 0 0 1 0 13"
                      : "M16 8a5 5 0 0 1 0 8"
                  }
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              ) : (
                <path d="M16 9l6 6m0-6l-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              )}
            </svg>
            <span className="text-[11.5px] text-gray-200 font-semibold tabular-nums">
              {volumePct === 0 ? "Muted" : `Volume ${volumePct}%`}
            </span>
          </div>
        ) : null}

        {streamError && !casting && !iframeFallback ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center z-20">
            <p className="text-[13px] text-gray-300">
              {offline
                ? "You\u2019re offline and this episode isn\u2019t saved on this device yet. Episodes you watch while online play without internet."
                : "Our player couldn\u2019t load this stream."}
            </p>
            <div className="flex gap-2">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setStreamError(false);
                  setStream(null);
                  fetch(`/api/stream?malId=${anime.malId}&ep=${episode}&lang=${lang}&server=${server}&fresh=1`)
                    .then((r) => (r.ok ? r.json() : null))
                    .then((d) => {
                      // same payload validation as the main resolve path — a
                      // 200-with-no-src used to rebuild the u=undefined playlist
                      if (d && typeof d.src === "string" && d.src) {
                        setStream({ src: d.src, subtitles: d.subtitles ?? [], skip: d.skip, referer: d.referer ?? null, pk: d.pk ?? null, heights: Array.isArray(d.heights) ? d.heights : undefined });
                      } else {
                        setStreamError(true);
                      }
                    })
                    .catch(() => setStreamError(true));
                }}
                className="bg-[#d32f2f] hover:bg-[#b71c1c] text-white text-[12.5px] font-bold rounded-full px-4 py-2 transition"
              >
                Retry
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setIframeFallback(true);
                }}
                className="bg-[#1c1c1c] hover:bg-[#282828] text-gray-200 text-[12.5px] font-bold rounded-full px-4 py-2 transition"
              >
                Use Zoko player
              </button>
            </div>
          </div>
        ) : null}

        {/* offline + embedded Zoko player: the third-party iframe needs the
            network — say so instead of letting its own error page confuse */}
        {offline && iframeFallback && !casting ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center z-20 pointer-events-none">
            <p className="text-[13px] text-gray-300">
              You&rsquo;re offline — the embedded player needs internet. Episodes you watched while
              online still play on our own player.
            </p>
          </div>
        ) : null}

        {/* ---- in-player TOP bar: back / title / download ---- */}
        <div
          className={`player-layer absolute inset-x-0 top-0 z-20 flex items-center gap-1 px-2 player-safe-top pb-7 bg-gradient-to-b from-black/85 via-black/45 to-transparent ${ui && !casting ? "opacity-100" : "opacity-0 pointer-events-none"}`}
          onClick={(e) => e.stopPropagation()}
        >
          <button onClick={onBack} className="p-1.5 hover:opacity-80 active:scale-95 transition" aria-label="Back">
            <ChevronLeft className="w-6 h-6" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (lang === "sub" && epHasDub === false) {
                // main chain can't dub this episode — but a BACKUP server
                // might carry it (Anivexa network): jump straight there
                const b = (backupDub ?? []).find((x) => (x.covered ?? []).includes(episode));
                if (b) {
                  stageSpot(); // resume exactly here after the backup jump
                  showPlayerMsg(`English DUB is on ${b.name} (backup server) — switched`);
                  onEpisodeChange(episode, "dub", b.server as ServerId);
                  return;
                }
                showPlayerMsg(
                  epDubThru === 0
                    ? "No English DUB available for this title yet"
                    : epDubThru != null
                      ? dubMissing.includes(episode)
                        ? "No English DUB for this episode yet"
                        : "The English DUB hasn't reached this episode yet"
                      : "No English DUB available for this title yet",
                );
                return;
              }
              const next: Lang = lang === "sub" ? "dub" : "sub";
              if (next === "dub" && dubServers && dubServers.length > 0 && !dubServers.includes(server)) {
                // this title's dub lives on the other server — jump there
                const target = dubServers[0];
                stageSpot(); // resume exactly here after the server jump
                showPlayerMsg(`DUB is on ${target === "kiwi" ? "Kiwi" : "Zoko"} for this title — switched server`);
                onEpisodeChange(episode, next, target);
                return;
              }
              stageSpot(); // SUB↔DUB on the same server re-resolves the stream
              setLang(next);
            }}
            className="font-slab text-[16px] font-bold truncate"
            title={epHasDub === false ? "No DUB for this episode — tap does nothing" : "Toggle SUB/DUB"}
          >
            {playerTitle}
          </button>
          <div className="flex-1" />
          {!isBackupServer(server) ? (
            <button onClick={() => setDownloadOpen(true)} className="p-1.5 hover:opacity-80 active:scale-95 transition" aria-label="Download">
              <Download className="w-5 h-5" />
            </button>
          ) : null}
        </div>

        {/* ---- in-player BOTTOM: seek bar with times + control row ---- */}
        <div
          className={`player-layer absolute inset-x-0 bottom-0 z-20 px-3 player-safe-bottom pt-9 md:px-6 md:pt-10 lg:px-10 bg-gradient-to-t from-black/90 via-black/55 to-transparent ${ui && !casting ? "opacity-100" : "opacity-0 pointer-events-none"}`}
          onClick={(e) => e.stopPropagation()}
        >
          {/* controls stay readable on wide screens: cap their width, keep the
              gradient full-bleed */}
          <div className="mx-auto w-full md:max-w-[760px] lg:max-w-[1040px]">
          {!iframeFallback ? (
            <div className="flex items-center gap-2 md:gap-3">
              <span className="text-[10.5px] md:text-[12.5px] lg:text-[13.5px] text-gray-200 tabular-nums w-11 md:w-14 lg:w-16 text-right shrink-0">{fmtTime(scrub ?? currentTime)}</span>
              <div className="relative h-4 md:h-5 flex items-center flex-1">
                <div className="absolute inset-x-0 h-[3px] md:h-[5px] bg-white/15 rounded-full overflow-hidden">
                  <div className="h-full bg-white/25" style={{ width: `${bufPct}%` }} />
                </div>
                <div className="absolute h-[3px] md:h-[5px] bg-[#d32f2f] rounded-full" style={{ width: `${pct}%` }} />
                <input
                  ref={seekRef}
                  type="range"
                  min={0}
                  max={duration || 0}
                  step={0.5}
                  value={scrub ?? currentTime}
                  onChange={(e) => userScrub(parseFloat(e.target.value))}
                  onPointerUp={() => {
                    if (scrub != null) {
                      seekTo(scrub);
                      setScrub(null);
                    }
                  }}
                  onPointerCancel={() => setScrub(null)}
                  onKeyUp={(e) => {
                    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                      if (scrub != null) seekTo(scrub);
                      setScrub(null);
                    }
                  }}
                  onBlur={() => setScrub(null)}
                  className="absolute inset-x-0 w-full appearance-none bg-transparent h-4 md:h-5 cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 md:[&::-webkit-slider-thumb]:w-4 md:[&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#d32f2f]"
                  aria-label="Seek"
                />
              </div>
              <span className="text-[10.5px] md:text-[12.5px] lg:text-[13.5px] text-gray-200 tabular-nums w-11 md:w-14 lg:w-16 shrink-0">{fmtTime(duration)}</span>
            </div>
          ) : null}

      <div className="mt-1 md:mt-2.5 flex items-center justify-between">
        <ControlButton icon={SkipBack} label="Previous" onClick={() => go(episode - 1)} disabled={episode <= 1} />
        <ControlButton icon={Lock} label="Lock" onClick={() => setLocked(true)} />
        <ControlButton icon={SlidersHorizontal} label="Quality" onClick={() => setPanel("quality")} />
        <ControlButton icon={Gauge} label="Speed" onClick={() => setPanel("speed")} />
        <ControlButton
          icon={Scan}
          label="Resize"
          onClick={() => setResizeMode((m) => ((m + 1) % 3) as 0 | 1 | 2)}
        />
        {/* manual fullscreen toggle for PC — covers the rare case where the
            browser denied the auto request (no gesture / iframe quirks) so
            the user is never stuck windowed with bars showing */}
        {!coarsePointer ? (
          <ControlButton
            icon={fsActive ? Minimize : Maximize}
            label={fsActive ? "Exit full screen" : "Full screen"}
            onClick={fullscreen}
          />
        ) : null}
        {castUsable && !iframeFallback ? (
          <ControlButton
            icon={Cast}
            label={casting ? "Stop" : "Cast"}
            active={casting}
            onClick={() => (casting ? stopCasting() : void startCasting())}
          />
        ) : null}
        <ControlButton icon={SkipForward} label="Next" onClick={() => go(episode + 1)} disabled={episode >= total} />
      </div>
          </div>
        </div>

        {/* locked — single unlock chip */}
        {locked ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setLocked(false);
            }}
            className="absolute top-16 right-4 z-30 flex items-center gap-2 bg-black/70 text-gray-300 hover:text-white rounded-full px-3 py-2 text-[12px] transition"
          >
            <Unlock className="w-4 h-4" /> Unlock
          </button>
        ) : null}

        {/* quality panel — real hls levels, slides up inside the player */}
        {panel === "quality" ? (
          <div className="absolute inset-x-0 bottom-0 z-40 bg-[#0d0d0d]/95 border-t border-[#222] rounded-t-xl px-4 py-3 max-h-[46vh] overflow-y-auto anim-sheet-up lg:inset-x-auto lg:w-[720px] lg:left-[calc(50%-360px)] lg:border-x lg:border-[#222]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between pb-2">
              <button onClick={() => setPanel(null)} className="text-gray-400 hover:text-white text-[12px] flex items-center gap-1">
                <ChevronLeft className="w-4 h-4" /> Back
              </button>
              <span className="text-[12px] text-gray-400">Quality & Subtitles</span>
              <button onClick={() => setPanel(null)} className="text-gray-400 hover:text-white" aria-label="Close panel">
                ✕
              </button>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <h4 className="font-slab font-bold text-[14px] mb-2">Quality</h4>
                <ul className="space-y-2">
                  <li>
                    <button onClick={() => applyQuality("auto")} className={`flex items-center gap-2 text-[13px] ${quality === "auto" ? "text-[#ff5252]" : "text-gray-300"}`}>
                      {quality === "auto" ? <Check className="w-4 h-4 text-[#d32f2f]" /> : <span className="w-4 h-4 rounded-sm border border-[#3a3a3a] inline-block" />}
                      Auto
                    </button>
                  </li>
                  {/* ALL levels the stream offers — highest first. Switching is
                      seamless: hls jumps rendition without restarting the
                      video, and the spot is saved the moment you tap. */}
                  {[...levels]
                    .map((l, i) => ({ l, i }))
                    .sort((a, b) => (b.l.height ?? 0) - (a.l.height ?? 0) || (b.l.bitrate ?? 0) - (a.l.bitrate ?? 0))
                    .map(({ l, i }) => (
                      <li key={i}>
                        <button onClick={() => applyQuality(i)} className={`flex items-center gap-2 text-[13px] ${quality === i ? "text-[#ff5252]" : "text-gray-300"}`}>
                          {quality === i ? <Check className="w-4 h-4 text-[#d32f2f]" /> : <span className="w-4 h-4 rounded-sm border border-[#3a3a3a] inline-block" />}
                          {l.height ? `${l.height}p` : `${Math.round((l.bitrate ?? 0) / 1000)}k`}
                        </button>
                      </li>
                    ))}
                  {levels.length === 0 ? (
                    <li className="text-[11.5px] text-gray-500">Single quality for this episode</li>
                  ) : null}
                </ul>
              </div>
              <div>
                <h4 className="font-slab font-bold text-[14px] mb-2">Subtitles</h4>
                <ul className="space-y-2 text-[13px]">
                  <li>
                    <button onClick={() => toggleSubs(false)} className={`flex items-center gap-2 ${!subsOn ? "text-[#ff5252]" : "text-gray-300"}`}>
                      {!subsOn ? <Check className="w-4 h-4 text-[#d32f2f]" /> : <span className="w-4 h-4 rounded-sm border border-[#3a3a3a] inline-block" />}
                      Off
                    </button>
                  </li>
                  {/* EVERY caption language the stream carries — Zoko sources
                      expose 10-20 (Arabic, Chinese, English, Spanish, ...).
                      The chosen track remounts the <track> element (key=src)
                      and rides along to Chromecast sessions too. */}
                  {(stream?.subtitles ?? []).map((t, i) => {
                    const active = subsOn && subTrack?.src === t.src;
                    return (
                      <li key={`${t.src}-${i}`}>
                        <button onClick={() => pickSubLang(i)} className={`flex items-center gap-2 ${active ? "text-[#ff5252]" : "text-gray-300"}`}>
                          {active ? <Check className="w-4 h-4 text-[#d32f2f]" /> : <span className="w-4 h-4 rounded-sm border border-[#3a3a3a] inline-block" />}
                          {t.label || `Track ${i + 1}`}
                        </button>
                      </li>
                    );
                  })}
                  {(stream?.subtitles ?? []).length === 0 ? (
                    <li className="text-[11.5px] text-gray-500">No captions for this episode</li>
                  ) : null}
                </ul>
              </div>
            </div>

            {/* stream server — switch mid-episode, playback resumes at the same second */}
            <div className="mt-4 pt-3 border-t border-[#242424]">
              <h4 className="font-slab font-bold text-[14px] mb-2">Server</h4>
              <div className="flex gap-2">
                {(["zoko", "kiwi"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => switchServer(s)}
                    disabled={s === server}
                    className={`flex-1 rounded-lg py-2 text-[12.5px] font-bold transition active:scale-[0.98] ${
                      s === server
                        ? "bg-[#d32f2f] text-white cursor-default"
                        : "bg-[#1c1c1c] hover:bg-[#282828] text-gray-200"
                    }`}
                  >
                    {s === "zoko" ? "Zoko (Server #1)" : "Kiwi (Server #2)"}
                    {s === server ? <span className="ml-1.5 text-[10px] font-normal">· in use</span> : null}
                  </button>
                ))}
              </div>
              {/* BACKUP DUB servers — one button per Anivexa provider whose
                  dub list contains THIS episode; hidden entirely when the
                  main chain dubs the episode. Switching keeps your spot. */}
              {(backupDub ?? [])
                .filter((b) => (b.covered ?? []).includes(episode))
                .map((b) => {
                  const active = server === b.server;
                  return (
                    <button
                      key={b.server}
                      onClick={() => switchServer(b.server as ServerId)}
                      disabled={active}
                      className={`mt-2 w-full rounded-lg py-2 text-[12.5px] font-bold transition active:scale-[0.98] ${
                        active
                          ? "bg-[#3b3b60] text-white cursor-default"
                          : "bg-[#1c1c2e] hover:bg-[#282840] text-gray-200"
                      }`}
                    >
                      {b.name} (backup DUB)
                      {active ? <span className="ml-1.5 text-[10px] font-normal">· in use</span> : null}
                    </button>
                  );
                })}
              <p className="mt-1.5 text-[10.5px] text-gray-500">Switching server keeps your exact spot — no restart.</p>
              <p className="mt-1 text-[10.5px] text-gray-600">Missing DUB episodes auto-fall back to SupaPlay, Yenime, or the Anivexa backup servers.</p>
            </div>
          </div>
        ) : null}

        {/* speed panel */}
        {panel === "speed" ? (
          <div className="absolute inset-x-0 bottom-0 z-40 bg-[#0d0d0d]/95 border-t border-[#222] rounded-t-xl px-4 py-3 anim-sheet-up lg:inset-x-auto lg:w-[720px] lg:left-[calc(50%-360px)] lg:border-x lg:border-[#222]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between pb-2">
              <button onClick={() => setPanel(null)} className="text-gray-400 hover:text-white text-[12px] flex items-center gap-1">
                <ChevronLeft className="w-4 h-4" /> Back
              </button>
              <h4 className="font-slab font-bold text-[14px]">Speed</h4>
              <span className="w-10" />
            </div>
            <div className="flex flex-wrap gap-2 justify-center pb-1">
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  onClick={() => applySpeed(s)}
                  className={`px-3 py-1.5 rounded-full text-[12.5px] transition ${s === speed ? "bg-white text-black font-bold" : "bg-[#1c1c1c] text-gray-300"}`}
                >
                  {s}×
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {/* download format dialog */}
      {downloadOpen ? (
        <div className="fixed inset-0 z-[60] bg-black/60 anim-backdrop flex items-center justify-center px-6" onClick={() => setDownloadOpen(false)}>
          <div
            className="w-full max-w-[340px] md:max-w-[400px] bg-[#2b2b2b] rounded-lg shadow-2xl overflow-hidden anim-sheet-up"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Download episode"
          >
            <div className="px-4 pt-3 pb-1 text-[13px] font-bold">Download episode</div>
            <div className="px-4 py-2 text-[12.5px] text-gray-300 leading-relaxed">
              MP4 · about {estimateSizeMB(anime.durationMin, "720p")} MB
              <span className="block text-[11px] text-gray-500 mt-0.5">
                The Zoko downloader serves one format per episode.
              </span>
            </div>
            <div className="flex justify-end gap-5 px-4 py-3">
              <a href={downloadUrl} target="_blank" rel="noreferrer" className="text-[#d32f2f] text-[12px] font-bold tracking-wide hover:opacity-80">
                DOWNLOAD
              </a>
              <button onClick={() => setDownloadOpen(false)} className="text-[#d32f2f] text-[12px] font-bold tracking-wide hover:opacity-80">
                CANCEL
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ControlButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  active,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  // reference style: icon and label side-by-side in one row inside the player;
  // desktop (md/lg) scales up so the row is readable across a fullscreen TV
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1 md:gap-1.5 disabled:opacity-30 active:scale-95 transition px-0.5 md:px-1.5 py-1 cursor-pointer ${active ? "text-[#ff5252]" : "text-gray-200 hover:text-white"}`}
    >
      <Icon className="w-3 h-3 md:w-[18px] md:h-[18px] lg:w-[22px] lg:h-[22px] shrink-0" />
      <span className="text-[10.5px] md:text-[12.5px] lg:text-[14px] leading-none whitespace-nowrap">{label}</span>
    </button>
  );
}
