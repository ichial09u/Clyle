"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowUpDown, MonitorPlay, Search, X } from "lucide-react";
import type { AnimeLite, EpisodesPayload } from "@/lib/types";
import {
  fetchServerProgress,
  getEpProgressAll,
  useProgressVersion,
} from "@/lib/client-store";
import { type Lang } from "@/lib/zoko";

/** percent -> red bar width inside the episode button (8% padding each side) */
function barWidth(p: { pos: number; dur: number; completed: boolean } | undefined): number {
  if (!p) return 0;
  if (p.completed) return 100;
  if (!p.dur || p.dur <= 0) return 0;
  return Math.min(100, Math.round((p.pos / p.dur) * 100));
}

/**
 * NEW badge — only for a genuine "new episode dropped" batch. A backlog
 * import (whole series / migration) re-stamps addedAt for hundreds of
 * episodes, and none of those should be flagged. Real weekly drops are a
 * handful of rows, so cap the badge to small recent batches.
 */
function computeNewEpisodes(episodes: Array<{ number: number; addedAt: string }>): Set<number> {
  const cutoff = Date.now() - 24 * 3600_000;
  const recent = episodes.filter((e) => Date.now() - Date.parse(e.addedAt) < cutoff);
  if (recent.length === 0 || recent.length > 15) return new Set();
  return new Set(recent.map((e) => e.number));
}

export default function EpisodesView({
  anime,
  onBack,
  onWatchEpisode,
}: {
  anime: AnimeLite;
  onBack: () => void;
  onWatchEpisode: (ep: number, server: "zoko" | "kiwi", lang: Lang) => void;
}) {
  const [data, setData] = useState<EpisodesPayload | null>(null);
  const [loadedFor, setLoadedFor] = useState<number | null>(null);
  const [desc, setDesc] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);
  const [picked, setPicked] = useState<number | null>(null); // episode awaiting server choice
  const progressVersion = useProgressVersion();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/anime/${anime.malId}/episodes`);
        if (!res.ok) return;
        const payload = (await res.json()) as EpisodesPayload;
        if (!cancelled) {
          setData(payload);
          setLoadedFor(anime.malId);
        }
      } catch {
        /* keep skeleton */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [anime.malId]);

  // red bars: local progress immediately, server rows merged in (fresh storage / other device)
  useEffect(() => {
    fetchServerProgress(anime.malId).catch(() => undefined);
  }, [anime.malId]);

  const episodesData = loadedFor === anime.malId ? data : null;

  const numbers = useMemo(() => {
    const total = episodesData?.total ?? anime.totalEpisodes ?? 0;
    const list: number[] = [];
    for (let n = 1; n <= total; n++) list.push(n);
    const filtered = filter ? list.filter((n) => String(n).includes(filter)) : list;
    return desc ? [...filtered].reverse() : filtered;
  }, [episodesData, anime.totalEpisodes, desc, filter]);

  const epProgress = progressVersion >= 0 ? getEpProgressAll(anime.malId) : {};

  const newEpisodes = useMemo(
    () => computeNewEpisodes(episodesData?.episodes ?? []),
    [episodesData],
  );

  const openServerSheet = (n: number) => setPicked(n);
  const play = (lang: Lang, server: "zoko" | "kiwi") => {
    if (picked != null) onWatchEpisode(picked, server, lang);
    setPicked(null);
  };

  return (
    <div className="pb-24 min-h-screen">
      {/* header */}
      <header className="sticky top-0 z-30 bg-black/95 backdrop-blur">
        <div className="flex items-center gap-3 px-3 pt-3 pb-2">
          <button onClick={onBack} className="p-1 -ml-1 hover:opacity-80 active:scale-95 transition" aria-label="Back">
            <ArrowLeft className="w-6 h-6" />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="font-slab text-[19px] font-bold leading-tight truncate">{episodesData?.title ?? anime.title}</h1>
            <p className="text-[12px] text-gray-400">Episodes{episodesData?.airing ? " • airing" : ""}</p>
          </div>
          <button
            onClick={() => setDesc((d) => !d)}
            className={`p-2 hover:opacity-80 active:scale-95 transition ${desc ? "text-[#ff5252]" : ""}`}
            aria-label="Toggle sort order"
            title={desc ? "Newest first" : "Oldest first"}
          >
            <ArrowUpDown className="w-5 h-5" />
          </button>
          <button
            onClick={() => setFilter((f) => (f === null ? "" : null))}
            className="p-2 hover:opacity-80 active:scale-95 transition"
            aria-label="Find episode"
          >
            <Search className="w-5 h-5" />
          </button>
        </div>
        {/* red loading line while the episode list is being fetched */}
        {!episodesData ? <div className="load-line h-[2px] mx-3 mb-1.5 rounded-full bg-white/10" /> : null}
        {filter !== null ? (
          <div className="px-4 pb-2.5">
            <div className="flex items-center bg-[#1c1c1c] rounded-md px-3">
              <Search className="w-4 h-4 text-gray-400 mr-2" />
              <input
                autoFocus
                inputMode="numeric"
                value={filter}
                onChange={(e) => setFilter(e.target.value.replace(/\D/g, ""))}
                placeholder="Jump to episode number…"
                className="flex-1 bg-transparent py-2 text-[14px] outline-none placeholder:text-gray-500"
              />
              {filter ? (
                <button onClick={() => setFilter("")} aria-label="Clear">
                  <X className="w-4 h-4 text-gray-400" />
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        {episodesData?.newlyAdded ? (
          <p className="px-4 pb-2 text-[11.5px] text-[#ff8a80]">
            {episodesData.newlyAdded} new episode{episodesData.newlyAdded > 1 ? "s" : ""} imported just now
          </p>
        ) : null}
      </header>

      {/* grid */}
      {!episodesData ? (
        <div className="grid grid-cols-5 gap-2 px-4 pt-4">
          {Array.from({ length: 20 }).map((_, i) => (
            <div key={i} className="h-[46px] rounded-md bg-[#161616] animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-5 gap-2 px-4 pt-3">
          {numbers.map((n) => {
            const pr = epProgress[String(n)];
            const pct = barWidth(pr);
            return (
              <button
                key={n}
                onClick={() => openServerSheet(n)}
                className="relative h-[46px] rounded-md bg-[#1c1c1c] hover:bg-[#282828] active:scale-95 transition text-[14px] font-medium overflow-hidden"
                title={episodesData.episodes.find((e) => e.number === n)?.title ?? `Episode ${n}${pct ? ` — ${pct}% watched` : ""}`}
              >
                {n}
                {newEpisodes.has(n) ? (
                  <span className="absolute -top-1 -right-1 bg-[#d32f2f] text-[8px] font-bold px-1 py-[1px] rounded-full">
                    NEW
                  </span>
                ) : null}
                {/* accurate watch-progress bar (red), sits at the bottom of the button */}
                {pct > 0 ? (
                  <span className="absolute left-[8%] right-[8%] bottom-[3px] h-[3px] rounded-full bg-white/12 overflow-hidden">
                    <span className="block h-full bg-[#d32f2f] rounded-full" style={{ width: `${pct}%` }} />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}

      {episodesData && numbers.length === 0 ? (
        <p className="px-4 mt-10 text-center text-gray-400 text-sm">No episodes match &ldquo;{filter}&rdquo;.</p>
      ) : null}

      {/* server picker sheet — mirrors the reference: "Choose a server & a
          server doesn't work, please choose another" + SUB/DUB Server #1/#2.
          Rendered through a portal to <body>: the view pane is a stacking
          context (z-20), so a fixed z-[60] sheet inside it still painted UNDER
          the z-40 bottom nav and the DUB row was cut off on phones. The portal
          hoists the sheet to the root stacking context where z-[60] > z-40.
          Safe-area padding keeps the buttons clear of the iOS home indicator. */}
      {picked != null
        ? createPortal(
          <div className="fixed inset-0 z-[60] bg-black/60 anim-backdrop flex items-end sm:items-center justify-center" onClick={() => setPicked(null)}>
            <div
              className="w-full sm:max-w-[400px] bg-[#151515] border-t sm:border sm:border-[#242424] sm:rounded-xl rounded-t-xl shadow-2xl overflow-hidden anim-sheet-up"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-label="Choose a server"
            >
              <div className="px-4 pt-4 pb-1 flex items-center justify-between">
                <h3 className="font-slab text-[16px] font-bold">Episode {picked}</h3>
                <button onClick={() => setPicked(null)} className="text-gray-400 hover:text-white" aria-label="Close">
                  <X className="w-5 h-5" />
                </button>
              </div>
              {(() => {
                const pr = epProgress[String(picked)];
                const pct = barWidth(pr);
                return pct > 0 ? (
                  <p className="px-4 text-[11.5px] text-[#ff8a80] pb-1">
                    {pr?.completed ? "Episode finished — replay from the start" : `You were ${pct}% through — it will resume automatically`}
                  </p>
                ) : null;
              })()}
              <p className="px-4 pb-3 text-[11.5px] text-gray-400">Choose a server &amp; a server doesn&apos;t work, please choose another</p>
              <div className="px-3" style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 20px)" }}>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { lang: "sub" as Lang, n: 1 },
                    { lang: "sub" as Lang, n: 2 },
                    // anime without a DUB yet — no DUB buttons at all
                    ...(episodesData?.hasDub === false
                      ? []
                      : [
                          { lang: "dub" as Lang, n: 1 },
                          { lang: "dub" as Lang, n: 2 },
                        ]),
                  ]).map(({ lang, n }) => (
                    <button
                      key={`${lang}-${n}`}
                      onClick={() => play(lang, n === 1 ? "zoko" : "kiwi")}
                      className="flex items-center justify-center gap-2 rounded-lg bg-white hover:bg-gray-200 active:scale-[0.98] transition text-[13px] font-bold py-3 text-black text-center"
                    >
                      <MonitorPlay className="w-4 h-4 text-[#d32f2f]" />
                      {lang.toUpperCase()} Server #{n}
                    </button>
                  ))}
                </div>
                {episodesData?.hasDub === false ? (
                  <p className="mt-2 text-center text-[10.5px] text-gray-500">No DUB available for this anime yet</p>
                ) : null}
              </div>
            </div>
          </div>,
          document.body,
          )
        : null}
    </div>
  );
}
