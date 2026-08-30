"use client";

import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft, Download, Lock, Unlock, SlidersHorizontal, Gauge, Scan, SkipBack, SkipForward, ExternalLink, Check,
} from "lucide-react";
import type { AnimeLite } from "@/lib/types";
import { zokoPlayerUrl, zokoDownloadUrl, estimateSizeMB, type Lang, type Quality } from "@/lib/zoko";
import { setProgress } from "@/lib/client-store";

type Panel = null | "quality" | "speed";

const QUALITIES: Quality[] = ["1080p", "720p", "360p"];
const SPEEDS = [0.25, 0.5, 1, 1.5, 2];

export default function WatchView({
  anime,
  episode,
  lang: initialLang,
  onBack,
  onEpisodeChange,
}: {
  anime: AnimeLite;
  episode: number;
  lang: Lang;
  onBack: () => void;
  onEpisodeChange: (ep: number, lang: Lang) => void;
}) {
  const [lang, setLang] = useState<Lang>(initialLang);
  const [panel, setPanel] = useState<Panel>(null);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [locked, setLocked] = useState(false);
  const [quality, setQuality] = useState<"Auto" | Quality>("Auto");
  const [speed, setSpeed] = useState(1);
  const [resizeMode, setResizeMode] = useState<0 | 1 | 2>(0); // fit width | fit height | fill
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

  const total = anime.totalEpisodes || episode;
  const playerUrl = zokoPlayerUrl(anime.malId, episode, lang);
  const downloadUrl = zokoDownloadUrl(anime.malId, episode, lang);
  const loaded = loadedUrl === playerUrl;

  useEffect(() => {
    setProgress(anime.malId, episode, lang);
  }, [anime.malId, episode, lang]);

  const go = (ep: number) => {
    if (ep >= 1 && ep <= total) onEpisodeChange(ep, lang);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col select-none">
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
          className="font-slab text-[16px] font-bold"
          title="Toggle SUB/DUB"
        >
          Episode {episode} {lang.toUpperCase()}
        </button>
        <div className="flex-1" />
        <a
          href={downloadUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-[11px] text-gray-300 hover:text-white bg-[#161616] rounded-full px-2.5 py-1 mr-1 transition"
          title="Open directly in Zoko"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          Zoko
        </a>
        <button
          onClick={() => setDownloadOpen(true)}
          className="p-1.5 hover:opacity-80 active:scale-95 transition"
          aria-label="Download"
        >
          <Download className="w-5 h-5" />
        </button>
      </div>

      {/* player */}
      <div className={`relative flex-1 flex items-center justify-center overflow-hidden ${resizeMode === 2 ? "" : "py-2"}`}>
        <iframe
          ref={frameRef}
          key={`${episode}-${lang}`}
          src={playerUrl}
          title={`${anime.title} — Episode ${episode} (${lang})`}
          onLoad={() => setLoadedUrl(playerUrl)}
          className={`w-full h-full border-0 bg-black ${resizeMode === 1 ? "max-w-[240px] mx-auto" : resizeMode === 2 ? "" : "aspect-video max-h-full"}`}
          allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin allow-presentation allow-forms allow-popups"
        />
        {!loaded ? (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-9 h-9 border-2 border-[#d32f2f] border-t-transparent rounded-full animate-spin" />
          </div>
        ) : null}
      </div>

      {/* bottom controls */}
      {!locked && !panel ? (
        <div className="flex items-center justify-around bg-[#101010] px-1 py-2.5 z-10">
          <ControlButton icon={SkipBack} label="Previous" onClick={() => go(episode - 1)} disabled={episode <= 1} />
          <ControlButton icon={Lock} label="Lock" onClick={() => setLocked(true)} />
          <ControlButton icon={SlidersHorizontal} label="Quality & Subtitles" onClick={() => setPanel("quality")} />
          <ControlButton icon={Gauge} label="Speed" onClick={() => setPanel("speed")} />
          <ControlButton
            icon={Scan}
            label="Resize"
            onClick={() => setResizeMode((m) => (((m + 1) % 3) as 0 | 1 | 2))}
          />
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

      {/* quality & subtitles panel (the stream itself is controlled inside Zoko's player) */}
      {panel === "quality" ? (
        <div className="bg-[#0d0d0d] border-t border-[#222] px-4 py-3 z-10">
          <div className="flex items-center justify-between pb-2">
            <button onClick={() => setPanel(null)} className="text-gray-400 hover:text-white text-[12px] flex items-center gap-1">
              <ChevronLeft className="w-4 h-4" /> Back
            </button>
            <span className="text-[12px] text-gray-400">Subtitle Options</span>
            <button onClick={() => setPanel(null)} className="text-gray-400 hover:text-white" aria-label="Close panel">
              ✕
            </button>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <h4 className="font-slab font-bold text-[14px] mb-2">Quality</h4>
              <ul className="space-y-2">
                {(["Auto", ...QUALITIES] as Array<"Auto" | Quality>).map((q) => (
                  <li key={q}>
                    <button
                      onClick={() => setQuality(q)}
                      className={`flex items-center gap-2 text-[13px] ${q === quality ? "text-[#ff5252]" : "text-gray-300"}`}
                    >
                      {q === quality ? <Check className="w-4 h-4 text-[#d32f2f]" /> : <span className="w-4 h-4 rounded-sm border border-[#3a3a3a] inline-block" />}
                      {q}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="font-slab font-bold text-[14px] mb-2">Subtitles</h4>
              <ul className="space-y-2 text-[13px] text-gray-400">
                <li>{lang === "sub" ? "English (SUB)" : "None (DUB audio)"}</li>
                <li className="text-[11px] leading-snug pt-2 text-gray-500">
                  Fine-grained quality & subtitle options live inside the Zoko player itself.
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
          <div className="flex gap-2 justify-center pb-1">
            {SPEEDS.map((s) => (
              <button
                key={s}
                onClick={() => setSpeed(s)}
                className={`px-3 py-1.5 rounded-full text-[12.5px] transition ${s === speed ? "bg-white text-black font-bold" : "bg-[#1c1c1c] text-gray-300"}`}
              >
                {s}×
              </button>
            ))}
          </div>
          <p className="text-center text-[10.5px] text-gray-500 pt-1">Playback speed is applied inside the Zoko player.</p>
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
              {(["360p", "720p", "1080p"] as Quality[]).map((q, i) => (
                <label key={q} className="flex items-center gap-3 text-[13px] cursor-pointer">
                  <input
                    type="radio"
                    name="dlq"
                    defaultChecked={i === 0}
                    className="accent-[#00c853] w-4 h-4"
                    onChange={() => undefined}
                  />
                  {q} ~ {estimateSizeMB(anime.durationMin, q).toFixed(2)} MB
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-5 px-4 py-3">
              <a
                href={downloadUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[#d32f2f] text-[12px] font-bold tracking-wide hover:opacity-80"
              >
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
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex flex-col items-center gap-1 text-gray-300 hover:text-white disabled:opacity-30 active:scale-95 transition px-1"
    >
      <Icon className="w-[18px] h-[18px]" />
      <span className="text-[9.5px] leading-none whitespace-nowrap">{label}</span>
    </button>
  );
}
