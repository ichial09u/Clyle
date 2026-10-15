"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Download, Loader2, X } from "lucide-react";
import type { AnimeLite } from "@/lib/types";
import { artUrl } from "@/lib/art";
import {
  type DlStreamPayload,
  downloadDirect,
  downloadHls,
  episodeFileBase,
  estMB,
  LADDER,
  pickHeight,
  proxied,
  saveBlob,
  saveSubtitleSrt,
} from "@/lib/device-download";

/**
 * EpisodeDownloadSheet — the per-episode download popup.
 *
 * Opened from the episode grid (corner download chip on every tile, or the
 * "Download this episode" action inside the server-picker sheet): pick SUB
 * or DUB, pick a quality, press Download. The video saves straight to the
 * device's download folder; SUB downloads also save the resolved subtitle
 * track as a matching .srt sidecar right next to the video file.
 *
 * Rendered through a portal to <body> (same reason as the server sheet:
 * the view pane is a stacking context and z-[60] must beat the z-40 nav).
 */

type JobState = "idle" | "resolving" | "downloading" | "done" | "error" | "cancelled";

export default function EpisodeDownloadSheet({
  anime,
  episode,
  episodeTitle,
  dubAvailable,
  durationMin,
  onClose,
}: {
  anime: AnimeLite;
  episode: number;
  episodeTitle: string | null;
  dubAvailable: boolean;
  durationMin: number;
  onClose: () => void;
}) {
  const [lang, setLang] = useState<"sub" | "dub">("sub");
  const [quality, setQuality] = useState(720);
  const [state, setState] = useState<JobState>("idle");
  const [gotBytes, setGotBytes] = useState(0);
  const [detail, setDetail] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const running = state === "resolving" || state === "downloading";

  // leaving the sheet (or the whole view) must not leave an orphaned fetch running
  useEffect(() => () => abortRef.current?.abort(), []);

  async function start() {
    const ctl = new AbortController();
    abortRef.current = ctl;
    setState("resolving");
    setError(null);
    setResult(null);
    setGotBytes(0);
    setDetail(`Resolving ${lang.toUpperCase()} source…`);
    try {
      const res = await fetch(`/api/stream?malId=${anime.malId}&ep=${episode}&lang=${lang}`, {
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`resolve HTTP ${res.status}`);
      const s = (await res.json()) as DlStreamPayload;

      const base = episodeFileBase(anime.titleEnglish || anime.title || String(anime.malId), episode);
      const h = pickHeight(quality, s.heights ?? s.qualitySrcs?.map((q) => q.height));
      setState("downloading");
      setDetail(`Downloading ${h}p…`);

      let blob: Blob;
      let ext: string;
      if (s.qualitySrcs?.length) {
        const q = s.qualitySrcs.find((x) => x.height === h) ?? s.qualitySrcs[0];
        blob = await downloadDirect(q.src, s, setGotBytes, ctl.signal);
        ext = "mp4";
      } else {
        const got = await downloadHls(proxied(s.src, s), h, setGotBytes, ctl.signal).catch(
          async (e) => {
            // proxy-renamed HLS failed? try the raw src (direct CDNs)
            if (/^https?:/i.test(s.src) && !s.src.startsWith(location.origin)) throw e;
            return downloadHls(s.src, h, setGotBytes, ctl.signal);
          },
        );
        blob = got.blob;
        ext = "ts";
      }
      const name = `${base} [${h}p].${ext}`;
      saveBlob(blob, name);

      // SUB downloads carry their captions: .srt sidecar, named like the video
      let note = "";
      if (lang === "sub") {
        if (s.subtitles?.length) {
          const ok = await saveSubtitleSrt(s.subtitles[0].src, s, base, ctl.signal);
          note = ok ? " — subtitles (.srt) saved too" : " — no subtitle file could be fetched";
        } else {
          note = " — no subtitle track exists for this episode";
        }
      }
      setResult(`${name}${note}`);
      setState("done");
    } catch (e) {
      if (ctl.signal.aborted) {
        setState("cancelled");
      } else {
        setState("error");
        setError(e instanceof Error ? e.message : "download failed");
      }
    } finally {
      abortRef.current = null;
    }
  }

  const mb = (gotBytes / 1_048_576).toFixed(1);

  return createPortal(
    <div
      className="fixed inset-0 z-[60] bg-black/60 anim-backdrop flex items-end sm:items-center justify-center"
      onClick={() => {
        if (!running) onClose();
      }}
    >
      <div
        className="w-full sm:max-w-[400px] bg-[#151515] border-t sm:border sm:border-[#242424] sm:rounded-xl rounded-t-xl shadow-2xl overflow-hidden anim-sheet-up"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Download episode"
      >
        {/* header */}
        <div className="px-4 pt-4 pb-2 flex items-center gap-3">
          <img src={artUrl(anime.image)} alt="" className="w-9 h-[52px] object-cover rounded-[4px] bg-[#1a1a1a]" />
          <div className="min-w-0 flex-1">
            <h3 className="font-slab text-[16px] font-bold leading-tight">Download Episode {episode}</h3>
            <p className="text-[11.5px] text-gray-400 truncate">
              {episodeTitle || anime.titleEnglish || anime.title}
            </p>
          </div>
          <button
            onClick={() => (running ? abortRef.current?.abort() : onClose())}
            className="w-8 h-8 rounded-full bg-[#1d1d1d] flex items-center justify-center hover:bg-[#2a2a2a] transition"
            aria-label={running ? "Cancel download" : "Close"}
          >
            <X className="w-4 h-4 text-gray-300" />
          </button>
        </div>

        {/* SUB / DUB + quality chips */}
        <div className="px-4 flex items-center gap-2 flex-wrap">
          <div className="flex rounded-md overflow-hidden border border-[#2c2c2c]">
            {(["sub", "dub"] as const).map((l) => (
              <button
                key={l}
                disabled={l === "dub" && !dubAvailable}
                onClick={() => setLang(l)}
                className={`px-3.5 py-1.5 text-[12px] font-bold uppercase tracking-wide transition ${
                  lang === l ? "bg-[#d32f2f] text-white" : "bg-[#181818] text-gray-300 hover:bg-[#222]"
                } ${l === "dub" && !dubAvailable ? "opacity-35 cursor-not-allowed" : ""}`}
              >
                {l}
                {l === "dub" && !dubAvailable ? " · n/a" : ""}
              </button>
            ))}
          </div>
          <div className="flex rounded-md overflow-hidden border border-[#2c2c2c] ml-auto">
            {LADDER.map((h) => (
              <button
                key={h}
                onClick={() => setQuality(h)}
                className={`px-3 py-1.5 text-[12px] font-bold transition ${
                  quality === h ? "bg-white text-black" : "bg-[#181818] text-gray-300 hover:bg-[#222]"
                }`}
              >
                {h}p
              </button>
            ))}
          </div>
        </div>
        <p className="px-4 mt-2 text-[11px] text-gray-500">
          ≈ {estMB(quality, durationMin)} MB ·{" "}
          {lang === "sub" ? "subtitles (.srt) saved with the video" : "English dub audio"}
          {!running && state === "idle" ? " · plays in any video app" : ""}
        </p>

        {/* progress / result / error zone */}
        {running ? (
          <div className="mx-4 mt-3 rounded-lg bg-[#1c1c1c] px-3 py-2.5">
            <div className="flex items-center gap-2 text-[12px] text-gray-200">
              <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0 text-[#ff5252]" />
              <span className="flex-1 truncate">{detail}</span>
              <span className="text-gray-400 tabular-nums">{mb} MB</span>
            </div>
            <div className="mt-2 h-[3px] rounded-full bg-white/10 overflow-hidden">
              <span className="block h-full w-1/3 bg-[#d32f2f] rounded-full animate-pulse" />
            </div>
          </div>
        ) : null}
        {state === "done" && result ? (
          <div className="mx-4 mt-3 rounded-lg bg-[#12240f] border border-[#2e5339] px-3 py-2.5 flex items-start gap-2">
            <Check className="w-4 h-4 text-green-400 shrink-0 mt-[1px]" />
            <p className="text-[11.5px] text-green-200 leading-snug break-all">
              Saved to your downloads folder: {result}
            </p>
          </div>
        ) : null}
        {state === "error" ? (
          <div className="mx-4 mt-3 rounded-lg bg-[#2a1212] border border-[#533030] px-3 py-2.5">
            <p className="text-[11.5px] text-[#ff8a80] leading-snug">Download failed — {error}</p>
            <p className="text-[10.5px] text-gray-500 mt-1">
              Try another quality, or DUB if SUB keeps failing.
            </p>
          </div>
        ) : null}
        {state === "cancelled" ? (
          <p className="mx-4 mt-3 text-[11.5px] text-gray-400">Download cancelled.</p>
        ) : null}

        {/* action */}
        <div className="px-4 pt-3 pb-4" style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 20px)" }}>
          <button
            onClick={() => {
              if (running) abortRef.current?.abort();
              else void start();
            }}
            className={`w-full flex items-center justify-center gap-2 rounded-md text-white text-[14px] font-bold py-2.5 transition active:scale-[0.98] ${
              running ? "bg-[#1d1d1d] hover:bg-[#2a2a2a]" : "bg-[#d32f2f] hover:bg-[#b71c1c]"
            }`}
          >
            {running ? (
              <>
                <X className="w-4 h-4" /> Cancel — {mb} MB so far
              </>
            ) : (
              <>
                <Download className="w-4 h-4" />
                {state === "done" ? "Download again" : state === "error" ? "Try again" : `Download · ≈${estMB(quality, durationMin)} MB`}
              </>
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
