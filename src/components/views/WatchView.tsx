"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Hls, { type Level } from "hls.js";
import {
  ChevronLeft, Download, Lock, Unlock, SlidersHorizontal, Gauge, Scan, SkipBack, SkipForward,
  Check, Play, Pause, Maximize, Subtitles, Zap, Cast,
} from "lucide-react";
import type { AnimeLite } from "@/lib/types";
import { zokoPlayerUrl, zokoDownloadUrl, estimateSizeMB, type Lang, type ServerId } from "@/lib/zoko";
import { setProgress, getEpProgress, fetchServerProgress, saveProgressDetailed } from "@/lib/client-store";
import {
  ensureCastSdk, castLoad, castLoadNext, castStop, castPosition, castDuration,
  getCastState, onCastStateChange, type CastState,
} from "@/lib/cast";

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
  const [stream, setStream] = useState<Resolved | null>(null);
  const [streamError, setStreamError] = useState(false);
  const [iframeFallback, setIframeFallback] = useState(false);

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

  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const seekRef = useRef<HTMLInputElement>(null);
  const resumeAtRef = useRef(0);
  const castStateRef = useRef<CastState>(getCastState());
  const castMediaUrlRef = useRef("");

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
        if (!res.ok) throw new Error("unavailable");
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
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.clearInterval(id);
      saveNow({ keepalive: true });
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [saveNow]);

  /* -------- cast progress heartbeat (positions come from the TV) -------- */
  useEffect(() => {
    if (castState !== "casting") return;
    const id = window.setInterval(() => {
      const pos = castPosition();
      if (pos == null) return;
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
    return () => window.clearInterval(id);
  }, [castState, anime.malId, anime.title, anime.image, anime.totalEpisodes, episode, lang, server]);

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
        void castLoadNext({
          src: castMediaUrlRef.current,
          title: `${anime.title} — Episode ${episode} (${lang.toUpperCase()})`,
          imageUrl: anime.image,
          startTime: resumeAtRef.current,
        });
        return;
      }

      if (resumeAtRef.current > 0 && Math.abs(video.currentTime - resumeAtRef.current) > 5) {
        video.currentTime = resumeAtRef.current;
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
    const onPlay = () => setPlaying(true);
    const onPause = () => {
      setPlaying(false);
      saveNow();
    };
    const onEnded = () => {
      setPlaying(false);
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

  const applyQuality = (q: "auto" | number) => {
    setQuality(q);
    if (hlsRef.current) hlsRef.current.currentLevel = q === "auto" ? -1 : q;
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
    });
    if (res.ok) {
      videoRef.current?.pause();
      setCastMsg(null);
    } else {
      setCastMsg(res.error ?? "Cast failed");
      window.setTimeout(() => setCastMsg(null), 4000);
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

  const skip = stream?.skip?.intro;
  const showSkip = skip && currentTime >= skip.start && currentTime <= skip.end;
  const subTrack = stream?.subtitles?.[0];

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufPct = duration > 0 ? (buffered / duration) * 100 : 0;
  const casting = castState === "casting";
  const castUsable = castState !== "unavailable";

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col select-none" ref={shellRef}>
      {/* top bar */}
      <div className="flex items-center gap-1 px-2 pt-3 pb-2 bg-gradient-to-b from-black to-transparent z-10">
        <button onClick={onBack} className="p-1.5 hover:opacity-80 active:scale-95 transition" aria-label="Back">
          <ChevronLeft className="w-6 h-6" />
        </button>
        <button
          onClick={() => {
            const next: Lang = lang === "sub" ? "dub" : "sub";
            setLang(next);
          }}
          className="font-slab text-[16px] font-bold truncate"
          title="Toggle SUB/DUB"
        >
          Episode {episode} {lang.toUpperCase()}
        </button>
        <div className="flex-1" />
        <button onClick={() => setDownloadOpen(true)} className="p-1.5 hover:opacity-80 active:scale-95 transition" aria-label="Download">
          <Download className="w-5 h-5" />
        </button>
      </div>

      {/* player surface */}
      <div className={`relative flex-1 flex items-center justify-center overflow-hidden bg-black ${resizeMode === 2 ? "" : "py-2"}`}>
        {!iframeFallback ? (
          <>
            <video
              ref={videoRef}
              playsInline
              poster={anime.banner ?? anime.image ?? undefined}
              className={`w-full h-full border-0 bg-black object-contain ${resizeMode === 1 ? "max-w-[240px] mx-auto" : ""}`}
              onClick={togglePlay}
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

            {/* casting overlay — playback lives on the TV now */}
            {casting ? (
              <div className="absolute inset-0 bg-black/80 backdrop-blur-sm flex flex-col items-center justify-center gap-3 z-10">
                <span className="w-14 h-14 rounded-full bg-[#d32f2f]/15 border border-[#d32f2f]/60 flex items-center justify-center">
                  <Cast className="w-7 h-7 text-[#ff5252]" />
                </span>
                <p className="text-[14px] font-bold">Casting to your TV</p>
                <p className="text-[11.5px] text-gray-400 max-w-[260px] text-center truncate">
                  {anime.title} · Episode {episode} ({lang.toUpperCase()})
                </p>
                <button
                  onClick={stopCasting}
                  className="mt-1 bg-[#d32f2f] hover:bg-[#b71c1c] text-white text-[12.5px] font-bold rounded-full px-5 py-2 transition active:scale-95"
                >
                  Stop casting
                </button>
              </div>
            ) : null}

            {/* center play overlay */}
            {ready && !playing && !casting ? (
              <button
                onClick={togglePlay}
                className="absolute inset-0 flex items-center justify-center"
                aria-label="Play"
              >
                <span className="w-16 h-16 rounded-full bg-black/55 backdrop-blur flex items-center justify-center">
                  <Play className="w-8 h-8 text-white ml-1" />
                </span>
              </button>
            ) : null}

            {/* buffering spinner */}
            {!ready && !streamError && !casting ? (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-9 h-9 border-2 border-[#d32f2f] border-t-transparent rounded-full animate-spin" />
              </div>
            ) : null}

            {/* resumed pill — "picked up where you left off" */}
            {resumedFrom != null && !casting ? (
              <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 bg-black/75 backdrop-blur rounded-full pl-3 pr-1.5 py-1.5">
                <span className="text-[11px] text-gray-200 whitespace-nowrap">Resumed at {fmtTime(resumedFrom)}</span>
                <button
                  onClick={() => {
                    seekTo(0);
                    setResumedFrom(null);
                  }}
                  className="text-[11px] font-bold text-[#ff8a80] hover:text-white bg-white/10 hover:bg-[#d32f2f] rounded-full px-2.5 py-1 transition"
                >
                  Start over
                </button>
              </div>
            ) : null}

            {/* skip intro */}
            {showSkip && !casting ? (
              <button
                onClick={() => seekTo(skip!.end)}
                className="absolute bottom-24 right-4 flex items-center gap-1.5 bg-black/70 hover:bg-black/85 text-white text-[12.5px] font-bold rounded-full px-4 py-2 transition z-10"
              >
                <Zap className="w-4 h-4 text-[#35d5bf]" /> Skip Intro
              </button>
            ) : null}

            {/* cast failure toast */}
            {castMsg ? (
              <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 bg-black/80 text-[11.5px] text-gray-200 rounded-full px-3.5 py-1.5 whitespace-nowrap">
                {castMsg}
              </div>
            ) : null}

            {streamError && !casting ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center">
                <p className="text-[13px] text-gray-300">Our player couldn&apos;t load this stream.</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
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
                    onClick={() => setIframeFallback(true)}
                    className="bg-[#1c1c1c] hover:bg-[#282828] text-gray-200 text-[12.5px] font-bold rounded-full px-4 py-2 transition"
                  >
                    Use Zoko player
                  </button>
                </div>
              </div>
            ) : null}

            {/* seek bar + inline controls */}
            {!locked && !panel && !casting ? (
              <div className="absolute bottom-0 inset-x-0 px-3 pb-2 pt-6 bg-gradient-to-t from-black/85 to-transparent z-10">
                <div className="relative h-4 flex items-center">
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
                    onChange={(e) => seekTo(parseFloat(e.target.value))}
                    className="absolute inset-x-0 w-full appearance-none bg-transparent h-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#d32f2f]"
                    aria-label="Seek"
                  />
                </div>
                <div className="flex items-center gap-3 mt-1">
                  <button onClick={togglePlay} aria-label={playing ? "Pause" : "Play"} className="text-white hover:opacity-80">
                    {playing ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
                  </button>
                  <span className="text-[11px] text-gray-300 tabular-nums">
                    {fmtTime(currentTime)} / {fmtTime(duration)}
                  </span>
                  <div className="flex-1" />
                  <button
                    onClick={() => toggleSubs(!subsOn)}
                    className={`hover:opacity-80 ${subsOn ? "text-white" : "text-gray-500"}`}
                    aria-label="Toggle subtitles"
                    title="Subtitles"
                  >
                    <Subtitles className="w-[18px] h-[18px]" />
                  </button>
                  <button onClick={fullscreen} className="text-white hover:opacity-80" aria-label="Fullscreen">
                    <Maximize className="w-[18px] h-[18px]" />
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          /* hard-sandboxed Zoko iframe fallback (no popups, no top navigation) */
          <iframe
            key={`zoko-${episode}-${lang}`}
            src={zokoPlayerUrl(anime.malId, episode, lang)}
            title={`${anime.title} — Episode ${episode} (${lang})`}
            className={`w-full h-full border-0 bg-black ${resizeMode === 1 ? "max-w-[240px] mx-auto" : resizeMode === 2 ? "" : "aspect-video max-h-full"}`}
            allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-presentation"
          />
        )}
      </div>

      {/* bottom control bar */}
      {!locked && !panel ? (
        <div className="flex items-center justify-around bg-[#101010] px-1 py-2.5 z-10">
          <ControlButton icon={SkipBack} label="Previous" onClick={() => go(episode - 1)} disabled={episode <= 1} />
          <ControlButton icon={Lock} label="Lock" onClick={() => setLocked(true)} />
          <ControlButton icon={SlidersHorizontal} label="Quality" onClick={() => setPanel("quality")} />
          <ControlButton icon={Gauge} label="Speed" onClick={() => setPanel("speed")} />
          <ControlButton
            icon={Scan}
            label="Resize"
            onClick={() => setResizeMode((m) => (((m + 1) % 3) as 0 | 1 | 2))}
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
      ) : null}

      {locked ? (
        <button
          onClick={() => setLocked(false)}
          className="fixed top-16 right-4 z-20 flex items-center gap-2 bg-black/70 text-gray-300 hover:text-white rounded-full px-3 py-2 text-[12px] transition"
        >
          <Unlock className="w-4 h-4" /> Unlock
        </button>
      ) : null}

      {/* quality panel — real hls levels */}
      {panel === "quality" ? (
        <div className="bg-[#0d0d0d] border-t border-[#222] px-4 py-3 z-10 max-h-[42vh] overflow-y-auto">
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
                {[...levels]
                  .map((l, i) => ({ l, i }))
                  .sort((a, b) => (b.l.height ?? 0) - (a.l.height ?? 0))
                  .slice(0, 5)
                  .map(({ l, i }) => (
                    <li key={i}>
                      <button onClick={() => applyQuality(i)} className={`flex items-center gap-2 text-[13px] ${quality === i ? "text-[#ff5252]" : "text-gray-300"}`}>
                        {quality === i ? <Check className="w-4 h-4 text-[#d32f2f]" /> : <span className="w-4 h-4 rounded-sm border border-[#3a3a3a] inline-block" />}
                        {l.height ? `${l.height}p` : `${Math.round((l.bitrate ?? 0) / 1000)}k`}
                      </button>
                    </li>
                  ))}
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
        </div>
      ) : null}

      {/* speed panel */}
      {panel === "speed" ? (
        <div className="bg-[#0d0d0d] border-t border-[#222] px-4 py-3 z-10">
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

      {/* download format dialog */}
      {downloadOpen ? (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center px-6" onClick={() => setDownloadOpen(false)}>
          <div
            className="w-full max-w-[340px] bg-[#2b2b2b] rounded-lg shadow-2xl overflow-hidden"
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
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex flex-col items-center gap-1 disabled:opacity-30 active:scale-95 transition px-1 ${active ? "text-[#ff5252]" : "text-gray-300 hover:text-white"}`}
    >
      <Icon className="w-[18px] h-[18px]" />
      <span className="text-[9.5px] leading-none whitespace-nowrap">{label}</span>
    </button>
  );
}
