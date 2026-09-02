"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Hls, { type Level } from "hls.js";
import {
  ChevronLeft, Download, Lock, Unlock, SlidersHorizontal, Gauge, Scan, SkipBack, SkipForward,
  Check, Play, Pause, Maximize, Subtitles, Zap, Cast, RotateCcw, RotateCw, FastForward,
} from "lucide-react";
import type { AnimeLite } from "@/lib/types";
import { zokoPlayerUrl, zokoDownloadUrl, estimateSizeMB, type Lang, type ServerId } from "@/lib/zoko";
import { setProgress, getEpProgress, fetchServerProgress, saveProgressDetailed, getEpThumb, saveEpThumb, recordWatchSeconds, setLangPref } from "@/lib/client-store";
import {
  ensureCastSdk, castLoad, castLoadNext, castStop, castPosition, castDuration,
  castIsPlaying, castTogglePlay, castSeek, getCastState, onCastStateChange,
  onCastMediaError, type CastState,
} from "@/lib/cast";
import { pickSubtitleTrack } from "@/lib/subtitles";

type Panel = null | "quality" | "speed" | "subs";
type Resolved = { src: string; subtitles: Array<{ lang: string; label: string; src: string }>; skip?: { intro?: { start: number; end: number }; outro?: { start: number; end: number } } };

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

const proxyUrl = (u: string, type: "m3u8" | "seg" | "vtt") => `/api/stream/proxy?type=${type}&u=${encodeURIComponent(u)}`;

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
    setLangPref(anime.malId, { lang, server });
  }, [anime.malId, lang, server]);
  const [stream, setStream] = useState<Resolved | null>(null);
  const [streamError, setStreamError] = useState(false);
  const [iframeFallback, setIframeFallback] = useState(false);
  // does this title have a REAL English dub? (null = still asking).
  // The server /api/stream also validates every dub play, so a stale value
  // can never put Japanese audio under a DUB label — this only drives the UI.
  const [hasDub, setHasDub] = useState<boolean | null>(null);
  // generic in-player toast (dub fallback notices); cast errors use castMsg
  const [playerMsg, setPlayerMsg] = useState<string | null>(null);

  useEffect(() => {
    let ok = true;
    fetch(`/api/anime/${anime.malId}/episodes`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { hasDub?: boolean } | null) => {
        if (ok && d && typeof d.hasDub === "boolean") setHasDub(d.hasDub);
      })
      .catch(() => undefined);
    return () => {
      ok = false;
    };
  }, [anime.malId]);

  const showPlayerMsg = (text: string, ms = 6_000) => {
    setPlayerMsg(text);
    window.setTimeout(() => setPlayerMsg((m) => (m === text ? null : m)), ms);
  };

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [levels, setLevels] = useState<Array<Level>>([]);
  const [quality, setQuality] = useState<"auto" | number>("auto");
  const [speed, setSpeed] = useState(1);
  const [subsOn, setSubsOn] = useState(true);
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
     episode + server drops you straight into fullscreen playback. On leave,
     EVERY exit path (back button, hardware back, tab switch) drops fullscreen
     and the rotation lock again. -------- */
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

  /* -------- Escape closes any open panel (then the download dialog) -------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (panelRef.current) {
        setPanel(null);
        return;
      }
      if (downloadOpenRef.current) setDownloadOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const total = anime.totalEpisodes || episode;
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

  /* -------- resolve the direct stream -------- */
  useEffect(() => {
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
          // DUB asked for but the server refuses (no dub page, or Zoko's
          // "dub" is the sub file re-uploaded — fake dub). Fall back to the
          // sub instead of showing an error: the viewer just wants to watch.
          if (lang === "dub") {
            showPlayerMsg("No English DUB available for this episode yet — playing SUB", 8_000);
            setLang("sub");
            return;
          }
          throw new Error("unavailable");
        }
        const data = (await res.json()) as Resolved;
        if (!cancelled) {
          setStream({ src: data.src, subtitles: data.subtitles ?? [], skip: data.skip });
          // absolute public URL the Chromecast receiver can fetch through our proxy
          castMediaUrlRef.current = `${window.location.origin}/api/stream/proxy?type=m3u8&u=${encodeURIComponent(data.src)}`;
        }
      } catch {
        if (!cancelled) setStreamError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [anime.malId, episode, lang, server]);

  /* -------- persist watch progress (heartbeat / pause / exit / ended) -------- */
  const saveNow = useCallback(
    (opts?: { keepalive?: boolean; completed?: boolean }) => {
      const v = videoRef.current;
      if (!v || iframeFallback) return;
      const pos = v.currentTime;
      const dur = v.duration || 0;
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
          title: `${anime.title} — Episode ${episode} (${lang.toUpperCase()})`,
          imageUrl: anime.image,
          startTime: pendingSeekRef.current ?? resumeAtRef.current,
          captions: cap ? { url: `${window.location.origin}/api/stream/proxy?type=vtt&u=${encodeURIComponent(cap.src)}`, label: cap.label || "English" } : undefined,
        }).then((ok) => {
          if (!ok) {
            setCastMsg("Couldn't load this episode on the TV — Stop casting, then cast again");
            window.setTimeout(() => setCastMsg(null), 12_000);
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

    if (Hls.isSupported()) {
      const hls = new Hls({
        // small start buffer, snappy startup
        maxBufferLength: 30,
        backBufferLength: 30,
      });
      hlsRef.current = hls;
      hls.loadSource(proxyUrl(stream.src, "m3u8"));
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        setLevels(data.levels ?? []);
        startPlayback();
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hls.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else if (!destroyed) {
          setStreamError(true);
        }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari native HLS
      video.src = proxyUrl(stream.src, "m3u8");
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
      setCurrentTime(video.currentTime);
      if (video.buffered.length) setBuffered(video.buffered.end(video.buffered.length - 1));
    };
    const onMeta = () => setDuration(video.duration || 0);
    const onPlay = () => {
      setPlaying(true);
      lastActiveRef.current = Date.now(); // playback resumed — start the clock
    };
    const onPause = () => {
      setPlaying(false);
      lastActiveRef.current = Date.now(); // paused — don't count idle time
      saveNow();
    };
    const onEnded = () => {
      setPlaying(false);
      lastActiveRef.current = Date.now();
      saveNow({ completed: true });
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

  /* -------- episode scene thumbnail (Crunchyroll-style Continue Watching art)
     Once per episode session, at a random moment 8-28s in, grab whatever
     frame is on screen and store it as this episode's thumbnail. Streams play
     through our same-origin proxy via MSE, so the canvas stays untainted;
     any failure is silently ignored (the poster art remains the fallback). */
  useEffect(() => {
    if (!ready || iframeFallback) return;
    if (getEpThumb(anime.malId, episode, lang)) return; // this episode already has its scene
    let tries = 0;
    let timer = 0;
    const capture = () => {
      timer = 0;
      const v = videoRef.current;
      if (!v || streamErrorRef.current || castStateRef.current === "casting") return;
      if (getEpThumb(anime.malId, episode, lang)) return; // captured meanwhile
      // wait for real frames: decoded video, actually playing, a few seconds in
      if (v.readyState < 2 || v.paused || v.ended || !v.videoWidth || v.currentTime < 3) {
        if (++tries <= 12) timer = window.setTimeout(capture, 5000);
        return;
      }
      try {
        const W = 224;
        const H = 126; // 16:9 card
        const canvas = document.createElement("canvas");
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        // center-crop the source frame to 16:9 so nothing looks squashed
        const srcAspect = v.videoWidth / v.videoHeight;
        let sx = 0;
        let sy = 0;
        let sw = v.videoWidth;
        let sh = v.videoHeight;
        if (srcAspect > W / H) {
          sw = v.videoHeight * (W / H);
          sx = (v.videoWidth - sw) / 2;
        } else {
          sh = v.videoWidth / (W / H);
          sy = (v.videoHeight - sh) / 2;
        }
        ctx.drawImage(v, sx, sy, sw, sh, 0, 0, W, H);
        const url = canvas.toDataURL("image/jpeg", 0.62);
        if (url.length > 64) saveEpThumb(anime.malId, episode, lang, url);
      } catch {
        /* tainted canvas / quota — poster stays the fallback */
      }
    };
    // the "random scene": fire at a random moment 8-28s into the session,
    // then poll every 5s until frames are really flowing (~1 min patience)
    timer = window.setTimeout(capture, 8000 + Math.floor(Math.random() * 20000));
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, [ready, iframeFallback, anime.malId, episode, lang]);

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
    video.currentTime = Math.max(0, Math.min(duration || s, s));
    setCurrentTime(video.currentTime);
  };

  // Crowd-learned Skip Intro: when a viewer manually scrubs forward from
  // inside the intro region well past it, that target is the best possible
  // hint where the OP ends on shows with no skip data (new seasons).
  // Throttled to one vote/minute; the server validates + takes medians.
  const lastSkipVoteRef = useRef(0);
  const userScrub = (to: number) => {
    const from = currentTime;
    seekTo(to);
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

  /** Switch stream server mid-playback without losing the spot. */
  const switchServer = (next: "zoko" | "kiwi") => {
    if (next === server || castStateRef.current === "casting") return;
    const pos = videoRef.current?.currentTime ?? 0;
    saveNow(); // save your spot RIGHT NOW
    pendingSeekRef.current = pos; // the new source resumes exactly here
    setPanel(null);
    onEpisodeChange(episode, lang, next);
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

  const fullscreen = () => {
    const el = shellRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    else el.requestFullscreen?.().catch(() => undefined);
  };

  /* -------- Chromecast actions -------- */
  const startCasting = async () => {
    if (!stream) return;
    const res = await castLoad({
      src: castMediaUrlRef.current,
      title: `${anime.title} — Episode ${episode} (${lang.toUpperCase()})`,
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
    }
    castStop();
  };

  // Skip buttons — three-tier data: Zoko payload → AniSkip dataset (merged
  // server-side in /api/stream) → crowd-learned scrub medians → last-resort
  // heuristic window (~90s OP) for TV-length episodes only, so we never cut
  // movies or shorts blindly.
  const introSkip: { start: number; end: number } | undefined =
    stream?.skip?.intro ?? (duration >= 300 && duration <= 1800 ? { start: 8, end: 90 } : undefined);
  const outroSkip = stream?.skip?.outro;
  const showSkipIntro = introSkip && currentTime >= introSkip.start && currentTime <= introSkip.end && !locked;
  const showSkipOutro = outroSkip && currentTime >= outroSkip.start && currentTime <= outroSkip.end && !locked;
  // Zoko tags EVERY subtitle track lang:"en" and often lists English NOT first
  // (FMA:B ep1: Arabic, Chinese, Chinese, Danish, Dutch, English, ...) — pick
  // the real English track instead of blindly playing subtitles[0].
  const subTrack = pickSubtitleTrack(stream?.subtitles);

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;
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
              poster={anime.banner ?? anime.image ?? undefined}
              className={`w-full h-full border-0 bg-black object-contain ${resizeMode === 1 ? "max-w-[240px] mx-auto" : ""}`}
            >
              {subTrack && subsOn ? (
                <track
                  key={subTrack.src}
                  kind="subtitles"
                  srcLang={subTrack.lang || "en"}
                  label={subTrack.label || "English"}
                  src={proxyUrl(subTrack.src, "vtt")}
                  default
                />
              ) : null}
            </video>

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
                    {anime.title} · Episode {episode} ({lang.toUpperCase()})
                  </p>
                </div>

                <div className="flex-1" />

                <div className="shrink-0 px-8 pb-10 md:pb-14 flex flex-col items-center gap-6">
                  {/* transport row */}
                  <div className="flex items-center gap-9 md:gap-14">
                    <button
                      onClick={() => castSkip(-10)}
                      className="relative w-12 h-12 md:w-14 md:h-14 rounded-full bg-black/45 border border-white/15 flex items-center justify-center hover:bg-black/65 active:scale-95 transition"
                      aria-label="Back 10 seconds"
                    >
                      <RotateCcw className="w-7 h-7 md:w-8 md:h-8 text-white" />
                      <span className="absolute inset-0 flex items-center justify-center text-[8.5px] font-bold text-white pt-1 pointer-events-none">10</span>
                    </button>
                    <button
                      onClick={castToggle}
                      className="w-16 h-16 md:w-20 md:h-20 rounded-full bg-white shadow-xl flex items-center justify-center hover:scale-105 active:scale-95 transition"
                      aria-label={castUi.playing ? "Pause on TV" : "Play on TV"}
                    >
                      {castUi.playing ? (
                        <Pause className="w-7 h-7 md:w-9 md:h-9 text-black fill-black" />
                      ) : (
                        <Play className="w-7 h-7 md:w-9 md:h-9 text-black ml-0.5 fill-black" />
                      )}
                    </button>
                    <button
                      onClick={() => castSkip(10)}
                      className="relative w-12 h-12 md:w-14 md:h-14 rounded-full bg-black/45 border border-white/15 flex items-center justify-center hover:bg-black/65 active:scale-95 transition"
                      aria-label="Forward 10 seconds"
                    >
                      <RotateCw className="w-7 h-7 md:w-8 md:h-8 text-white" />
                      <span className="absolute inset-0 flex items-center justify-center text-[8.5px] font-bold text-white pt-1 pointer-events-none">10</span>
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
                  className="relative w-12 h-12 md:w-14 md:h-14 rounded-full bg-black/45 backdrop-blur-sm flex items-center justify-center hover:bg-black/65 active:scale-95 transition pointer-events-auto"
                  aria-label="Back 10 seconds"
                >
                  <RotateCcw className="w-7 h-7 md:w-8 md:h-8 text-white" />
                  <span className="absolute inset-0 flex items-center justify-center text-[8.5px] font-bold text-white pt-1 pointer-events-none">10</span>
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePlay();
                  }}
                  className="w-16 h-16 md:w-20 md:h-20 rounded-full bg-white shadow-xl flex items-center justify-center hover:scale-105 active:scale-95 transition pointer-events-auto"
                  aria-label={playing ? "Pause" : "Play"}
                >
                  {playing ? (
                    <Pause className="w-7 h-7 md:w-9 md:h-9 text-black fill-black" />
                  ) : (
                    <Play className="w-7 h-7 md:w-9 md:h-9 text-black ml-0.5 fill-black" />
                  )}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    seekTo(Math.min(duration || 0, currentTime + 10));
                    showUi();
                  }}
                  className="relative w-12 h-12 md:w-14 md:h-14 rounded-full bg-black/45 backdrop-blur-sm flex items-center justify-center hover:bg-black/65 active:scale-95 transition pointer-events-auto"
                  aria-label="Forward 10 seconds"
                >
                  <RotateCw className="w-7 h-7 md:w-8 md:h-8 text-white" />
                  <span className="absolute inset-0 flex items-center justify-center text-[8.5px] font-bold text-white pt-1 pointer-events-none">10</span>
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
                title={`${anime.title} — Episode ${episode} (${lang})`}
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
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 bg-black/75 backdrop-blur rounded-full pl-3 pr-1.5 py-1.5 player-layer" style={{ top: "3.25rem" }}>
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

        {/* skip intro / skip ending — appear when the window opens, fade out
            after 3s untapped, come back whenever the player UI is summoned */}
        {showSkipOutro && !casting && !iframeFallback ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              seekTo(outroSkip!.end);
              showUi();
            }}
            className={`absolute bottom-44 right-4 flex items-center gap-1.5 bg-black/70 hover:bg-black/85 text-white text-[12.5px] font-bold rounded-full px-4 py-2 transition-all duration-500 z-10 ${
              skipAwake ? "opacity-100" : "opacity-0 pointer-events-none"
            }`}
          >
            <FastForward className="w-4 h-4 text-[#35d5bf]" /> Skip Ending
          </button>
        ) : null}
        {showSkipIntro && !casting && !iframeFallback ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              seekTo(introSkip!.end);
              showUi();
            }}
            className={`absolute bottom-28 right-4 flex items-center gap-1.5 bg-black/70 hover:bg-black/85 text-white text-[12.5px] font-bold rounded-full px-4 py-2 transition-all duration-500 z-10 ${
              skipAwake ? "opacity-100" : "opacity-0 pointer-events-none"
            }`}
          >
            <Zap className="w-4 h-4 text-[#35d5bf]" /> Skip Intro
          </button>
        ) : null}

        {/* player toast: cast failures + dub-fallback notices (never both) */}
        {castMsg || playerMsg ? (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 bg-black/80 text-[11.5px] text-gray-200 rounded-2xl px-3.5 py-1.5 max-w-[92%] text-center">
            {castMsg ?? playerMsg}
          </div>
        ) : null}

        {streamError && !casting && !iframeFallback ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center z-20">
            <p className="text-[13px] text-gray-300">Our player couldn&apos;t load this stream.</p>
            <div className="flex gap-2">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setStreamError(false);
                  setStream(null);
                  fetch(`/api/stream?malId=${anime.malId}&ep=${episode}&lang=${lang}&server=${server}&fresh=1`)
                    .then((r) => (r.ok ? r.json() : null))
                    .then((d) => d && setStream({ src: d.src, subtitles: d.subtitles ?? [], skip: d.skip }))
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

        {/* ---- in-player TOP bar: back / title / download ---- */}
        <div
          className={`player-layer absolute inset-x-0 top-0 z-20 flex items-center gap-1 px-2 pt-3 pb-7 bg-gradient-to-b from-black/85 via-black/45 to-transparent ${ui && !casting ? "opacity-100" : "opacity-0 pointer-events-none"}`}
          onClick={(e) => e.stopPropagation()}
        >
          <button onClick={onBack} className="p-1.5 hover:opacity-80 active:scale-95 transition" aria-label="Back">
            <ChevronLeft className="w-6 h-6" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (lang === "sub" && hasDub === false) {
                showPlayerMsg("No English DUB available for this title yet");
                return;
              }
              const next: Lang = lang === "sub" ? "dub" : "sub";
              setLang(next);
            }}
            className="font-slab text-[16px] font-bold truncate"
            title={hasDub === false ? "No DUB available — tap does nothing" : "Toggle SUB/DUB"}
          >
            Episode {episode} {lang.toUpperCase()}
          </button>
          <div className="flex-1" />
          <button onClick={() => setDownloadOpen(true)} className="p-1.5 hover:opacity-80 active:scale-95 transition" aria-label="Download">
            <Download className="w-5 h-5" />
          </button>
        </div>

        {/* ---- in-player BOTTOM: seek bar with times + control row ---- */}
        <div
          className={`player-layer absolute inset-x-0 bottom-0 z-20 px-3 pb-2.5 pt-9 bg-gradient-to-t from-black/90 via-black/55 to-transparent ${ui && !casting ? "opacity-100" : "opacity-0 pointer-events-none"}`}
          onClick={(e) => e.stopPropagation()}
        >
          {/* controls stay readable on wide screens: cap their width, keep the
              gradient full-bleed */}
          <div className="mx-auto w-full md:max-w-[760px] lg:max-w-[1040px]">
          {!iframeFallback ? (
            <div className="flex items-center gap-2">
              <span className="text-[10.5px] text-gray-200 tabular-nums w-11 text-right shrink-0">{fmtTime(currentTime)}</span>
              <div className="relative h-4 flex items-center flex-1">
                <div className="absolute inset-x-0 h-[3px] bg-white/15 rounded-full overflow-hidden">
                  <div className="h-full bg-white/25" style={{ width: `${bufPct}%` }} />
                </div>
                <div className="absolute h-[3px] bg-[#d32f2f] rounded-full" style={{ width: `${pct}%` }} />
                <input
                  ref={seekRef}
                  type="range"
                  min={0}
                  max={duration || 0}
                  step={0.5}
                  value={currentTime}
                  onChange={(e) => userScrub(parseFloat(e.target.value))}
                  className="absolute inset-x-0 w-full appearance-none bg-transparent h-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#d32f2f]"
                  aria-label="Seek"
                />
              </div>
              <span className="text-[10.5px] text-gray-200 tabular-nums w-11 shrink-0">{fmtTime(duration)}</span>
            </div>
          ) : null}

      <div className="mt-1 flex items-center justify-between">
        <ControlButton icon={SkipBack} label="Previous" onClick={() => go(episode - 1)} disabled={episode <= 1} />
        <ControlButton icon={Lock} label="Lock" onClick={() => setLocked(true)} />
        <ControlButton icon={SlidersHorizontal} label="Quality" onClick={() => setPanel("quality")} />
        <ControlButton icon={Gauge} label="Speed" onClick={() => setPanel("speed")} />
        <ControlButton
          icon={Scan}
          label="Resize"
          onClick={() => setResizeMode((m) => ((m + 1) % 3) as 0 | 1 | 2)}
        />
        {castUsable ? (
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
                    <button onClick={() => toggleSubs(true)} className={`flex items-center gap-2 ${subsOn ? "text-[#ff5252]" : "text-gray-300"}`}>
                      {subsOn ? <Check className="w-4 h-4 text-[#d32f2f]" /> : <span className="w-4 h-4 rounded-sm border border-[#3a3a3a] inline-block" />}
                      {subTrack?.label || "English"}
                    </button>
                  </li>
                  <li>
                    <button onClick={() => toggleSubs(false)} className={`flex items-center gap-2 ${!subsOn ? "text-[#ff5252]" : "text-gray-300"}`}>
                      {!subsOn ? <Check className="w-4 h-4 text-[#d32f2f]" /> : <span className="w-4 h-4 rounded-sm border border-[#3a3a3a] inline-block" />}
                      Off
                    </button>
                  </li>
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
              <p className="mt-1.5 text-[10.5px] text-gray-500">Switching server keeps your exact spot — no restart.</p>
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
            aria-label="Select Download Format"
          >
            <div className="px-4 pt-3 pb-1 text-[13px] font-bold">Select Download Format</div>
            <div className="px-4 py-2 space-y-2.5">
              {(["360p", "720p", "1080p"] as const).map((q, i) => (
                <label key={q} className="flex items-center gap-3 text-[13px] cursor-pointer">
                  <input type="radio" name="dlq" defaultChecked={i === 0} className="accent-[#00c853] w-4 h-4" onChange={() => undefined} />
                  {q} ~ {estimateSizeMB(anime.durationMin, q).toFixed(2)} MB
                </label>
              ))}
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
  // reference style: icon and label side-by-side in one row inside the player
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1 disabled:opacity-30 active:scale-95 transition px-0.5 py-1 ${active ? "text-[#ff5252]" : "text-gray-200 hover:text-white"}`}
    >
      <Icon className="w-3 h-3 md:w-3.5 md:h-3.5 shrink-0" />
      <span className="text-[10.5px] md:text-[11.5px] leading-none whitespace-nowrap">{label}</span>
    </button>
  );
}
