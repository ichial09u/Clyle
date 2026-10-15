"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Loader2, X } from "lucide-react";
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
 * DownloadPanel — offline download flow mounted from the details page.
 *
 * What it does
 *   1. pulls the episode grid from /api/anime/{malId}/episodes (same data the
 *      player grid uses: numbers, titles, hasDub/hasSub verdicts)
 *   2. SUB / DUB toggle gated by the anime's real availability
 *   3. quality ladder chips + an honest MB estimate (fleet-measured bitrates,
 *      not the naive 1080p≈4.5Mbps guess that scared everyone off)
 *   4. per-episode download = /api/stream resolve → either the direct MP4
 *      (WCO/LM2 progressive encodes) or the proxied HLS variant downloaded
 *      segment-by-segment through our own /api/stream/proxy (everything stays
 *      same-origin, so fetch + progress just work) → Blob → save
 *   5. CC comes bundled with SUB: the resolved subtitle track is converted
 *      VTT → SRT and saved as a sidecar right after the video file
 *      (engine shared with the per-episode sheet: lib/device-download.ts)
 *
 * Files land in the browser's download folder as
 *   "{Show} EP{n} [{h}p].{mp4|ts}" (+ ".srt" when subtitles ride along).
 */

interface EpRow {
  number: number;
  title: string | null;
  aired: number | null;
}

/** DetailsView hands us its AnimeLite; dub availability rides on the DB row,
 *  so the prop accepts the flag as an optional overlay. */
type PanelAnime = AnimeLite & { hasDub?: boolean | null };

interface Job {
  ep: number;
  state: "queued" | "resolving" | "downloading" | "done" | "error" | "cancelled";
  gotBytes: number;
  error?: string;
}

export default function DownloadPanel({ anime, onClose }: { anime: PanelAnime; onClose: () => void }) {
  const [eps, setEps] = useState<EpRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [lang, setLang] = useState<"sub" | "dub">("sub");
  const [quality, setQuality] = useState(720);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [jobs, setJobs] = useState<Record<number, Job>>({});
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // episode grid (same endpoint the player grid uses)
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const res = await fetch(`/api/anime/${anime.malId}/episodes`);
        const j = await res.json();
        if (!dead && Array.isArray(j?.episodes)) setEps(j.episodes as EpRow[]);
      } catch {
        /* grid stays empty — download just won't list episodes */
      } finally {
        if (!dead) setLoading(false);
      }
    })();
    return () => {
      dead = true;
    };
  }, [anime.malId]);

  const durationMin = useMemo(() => anime.durationMin || 24, [anime.durationMin]);
  const hasDub = anime.hasDub === true;
  const canRun = picked.size > 0 && !running;

  const toggleEp = (n: number) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  const totalEst = useMemo(
    () => [...picked].reduce((sum) => sum + estMB(quality, durationMin), 0),
    [picked, quality, durationMin],
  );

  async function run() {
    const ctl = new AbortController();
    abortRef.current = ctl;
    setRunning(true);
    const list = [...picked].sort((a, b) => a - b);
    setJobs(Object.fromEntries(list.map((ep) => [ep, { ep, state: "queued", gotBytes: 0 } as Job])));

    for (const ep of list) {
      if (ctl.signal.aborted) break;
      const setJob = (patch: Partial<Job>) =>
        setJobs((j) => (j[ep] ? { ...j, [ep]: { ...j[ep], ...patch } } : j));
      setJob({ state: "resolving" });
      setStatus(`Resolving EP ${ep} (${lang.toUpperCase()})…`);
      try {
        const res = await fetch(`/api/stream?malId=${anime.malId}&ep=${ep}&lang=${lang}`, { signal: ctl.signal });
        if (!res.ok) throw new Error(`resolve HTTP ${res.status}`);
        const s = (await res.json()) as DlStreamPayload;

        const base = episodeFileBase(anime.titleEnglish || anime.title || String(anime.malId), ep);
        const h = pickHeight(quality, s.heights ?? s.qualitySrcs?.map((q) => q.height));
        setStatus(`Downloading EP ${ep} (${h}p)…`);
        setJob({ state: "downloading" });

        let blob: Blob;
        let ext: string;
        if (s.qualitySrcs?.length) {
          const q = s.qualitySrcs.find((x) => x.height === h) ?? s.qualitySrcs[0];
          blob = await downloadDirect(q.src, s, (n) => setJob({ gotBytes: n }), ctl.signal);
          ext = "mp4";
        } else {
          const got = await downloadHls(proxied(s.src, s), h, (n) => setJob({ gotBytes: n }), ctl.signal).catch(
            async (e) => {
              // proxy-renamed HLS failed? try the raw src (direct CDNs)
              if (/^https?:/i.test(s.src) && !s.src.startsWith(location.origin)) throw e;
              return downloadHls(s.src, h, (n) => setJob({ gotBytes: n }), ctl.signal);
            },
          );
          blob = got.blob;
          ext = "ts";
        }
        saveBlob(blob, `${base} [${h}p].${ext}`);

        // CC bundled with SUB — sidecar subtitle (.srt) next to the video
        if (lang === "sub" && s.subtitles?.length) {
          await saveSubtitleSrt(s.subtitles[0].src, s, base, ctl.signal);
        }
        setJob({ state: "done" });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "failed";
        setJob({ state: ctl.signal.aborted ? "cancelled" : "error", error: msg });
        if (ctl.signal.aborted) break;
      }
    }
    setStatus(null);
    setRunning(false);
    abortRef.current = null;
  }

  const doneCount = Object.values(jobs).filter((j) => j.state === "done").length;

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center">
      <button aria-label="Close" onClick={running ? undefined : onClose} className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      <div className="relative w-full md:max-w-[560px] max-h-[88vh] md:max-h-[82vh] overflow-hidden rounded-t-2xl md:rounded-2xl bg-[#101010] border border-[#242424] shadow-[0_-8px_40px_rgba(0,0,0,0.6)] flex flex-col">
        {/* header */}
        <div className="flex items-center gap-3 p-4 border-b border-[#1f1f1f] shrink-0">
          <img src={artUrl(anime.image)} alt="" className="w-11 h-16 object-cover rounded-[4px] bg-[#1a1a1a]" />
          <div className="min-w-0 flex-1">
            <h2 className="font-slab text-[17px] font-bold leading-tight truncate">Download</h2>
            <p className="text-[12px] text-gray-400 truncate">{anime.titleEnglish || anime.title}</p>
          </div>
          <button
            onClick={() => (running ? abortRef.current?.abort() : onClose())}
            className="w-8 h-8 rounded-full bg-[#1d1d1d] flex items-center justify-center hover:bg-[#2a2a2a] transition"
            aria-label={running ? "Cancel downloads" : "Close"}
          >
            <X className="w-4 h-4 text-gray-300" />
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-3 grow">
          {/* SUB / DUB + quality row */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex rounded-md overflow-hidden border border-[#2c2c2c]">
              {(["sub", "dub"] as const).map((l) => (
                <button
                  key={l}
                  disabled={l === "dub" && !hasDub}
                  onClick={() => setLang(l)}
                  className={`px-3.5 py-1.5 text-[12px] font-bold uppercase tracking-wide transition ${
                    lang === l ? "bg-[#d32f2f] text-white" : "bg-[#181818] text-gray-300 hover:bg-[#222]"
                  } ${l === "dub" && !hasDub ? "opacity-35 cursor-not-allowed" : ""}`}
                >
                  {l}
                  {l === "dub" && !hasDub ? " ·n/a" : ""}
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
          <p className="mt-2 text-[11px] text-gray-500">
            ≈ {estMB(quality, durationMin)} MB / episode ({durationMin} min avg) · {lang === "sub" ? "CC (.srt) bundled" : "dub audio"}
          </p>

          {/* episode grid */}
          <div className="flex items-center justify-between mt-3 mb-1.5">
            <span className="text-[12px] font-bold text-gray-300">{eps.length || "—"} episodes</span>
            <div className="flex gap-2">
              <button
                onClick={() => setPicked(new Set(eps.map((e) => e.number)))}
                className="text-[11px] text-gray-400 hover:text-white"
              >
                Select all
              </button>
              <button onClick={() => setPicked(new Set())} className="text-[11px] text-gray-400 hover:text-white">
                Clear
              </button>
            </div>
          </div>

          {loading ? (
            <div className="py-10 flex justify-center">
              <Loader2 className="w-6 h-6 text-gray-500 animate-spin" />
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {eps.map((e) => {
                const on = picked.has(e.number);
                const job = jobs[e.number];
                return (
                  <button
                    key={e.number}
                    onClick={() => !running && toggleEp(e.number)}
                    className={`relative rounded-[6px] overflow-hidden border-2 transition active:scale-[0.97] ${
                      on ? "border-[#d32f2f]" : "border-transparent"
                    }`}
                  >
                    <img src={artUrl(anime.image)} alt="" loading="lazy" className="w-full aspect-[2/3] object-cover bg-[#1a1a1a]" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-transparent" />
                    <span className="absolute left-1.5 top-1.5 bg-black/75 text-[10px] font-bold px-1.5 py-0.5 rounded">
                      EP {e.number}
                    </span>
                    {job ? (
                      <span
                        className={`absolute right-1.5 top-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded ${
                          job.state === "done"
                            ? "bg-green-600 text-white"
                            : job.state === "error"
                              ? "bg-[#d32f2f] text-white"
                              : "bg-black/80 text-gray-200"
                        }`}
                      >
                        {job.state === "done" ? "✓" : job.state === "error" ? "!" : "…"}
                      </span>
                    ) : null}
                    <span className="absolute inset-x-1 bottom-1 text-[10px] text-gray-200 truncate text-left">
                      {e.title || `Episode ${e.number}`}
                    </span>
                  </button>
                );
              })}
              {!eps.length ? (
                <p className="col-span-3 text-center text-[12px] text-gray-500 py-8">
                  No local episodes yet — open the episodes page once to materialize the grid, then come back.
                </p>
              ) : null}
            </div>
          )}

          {/* job log */}
          {Object.values(jobs).some((j) => j.state === "downloading" || j.state === "resolving") ? (
            <div className="mt-3 space-y-1.5">
              {Object.values(jobs)
                .filter((j) => j.state === "downloading" || j.state === "resolving")
                .map((j) => (
                  <div key={j.ep} className="flex items-center gap-2 text-[11px] text-gray-300">
                    <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                    <span className="w-14">EP {j.ep}</span>
                    <span className="text-gray-500">{j.state === "resolving" ? "resolving…" : `${(j.gotBytes / 1_048_576).toFixed(1)} MB`}</span>
                  </div>
                ))}
            </div>
          ) : null}
        </div>

        {/* footer */}
        <div className="p-4 border-t border-[#1f1f1f] shrink-0">
          {status ? <p className="mb-2 text-[11px] text-gray-400 truncate">{status}</p> : null}
          <button
            onClick={() => (running ? abortRef.current?.abort() : run())}
            disabled={!running && !canRun}
            className="w-full flex items-center justify-center gap-2 rounded-md bg-[#d32f2f] hover:bg-[#b71c1c] disabled:opacity-45 disabled:hover:bg-[#d32f2f] text-white text-[14px] font-bold py-2.5 transition"
          >
            {running ? (
              <>
                <X className="w-4 h-4" /> Cancel ({doneCount}/{picked.size} saved)
              </>
            ) : (
              <>
                <Download className="w-4 h-4" /> Download {picked.size || ""} {picked.size === 1 ? "episode" : "episodes"}
                {picked.size ? ` · ≈${totalEst} MB` : ""}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
