"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowUpDown, Search, X } from "lucide-react";
import type { AnimeLite, EpisodesPayload } from "@/lib/types";
import { getProgress, useProgressVersion } from "@/lib/client-store";

export default function EpisodesView({
  anime,
  onBack,
  onWatchEpisode,
}: {
  anime: AnimeLite;
  onBack: () => void;
  onWatchEpisode: (ep: number) => void;
}) {
  const [data, setData] = useState<EpisodesPayload | null>(null);
  const [loadedFor, setLoadedFor] = useState<number | null>(null);
  const [desc, setDesc] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);
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

  const episodesData = loadedFor === anime.malId ? data : null;

  const numbers = useMemo(() => {
    const total = episodesData?.total ?? anime.totalEpisodes ?? 0;
    const list: number[] = [];
    for (let n = 1; n <= total; n++) list.push(n);
    const filtered = filter ? list.filter((n) => String(n).includes(filter)) : list;
    return desc ? [...filtered].reverse() : filtered;
  }, [episodesData, anime.totalEpisodes, desc, filter]);

  const progress = progressVersion >= 0 ? getProgress(anime.malId) : null;

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
            {episodesData.newlyAdded} new episode{episodesData.newlyAdded > 1 ? "s" : ""} imported from MAL just now
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
            const isCurrent = progress?.ep === n;
            const isNew = episodesData.episodes.find((e) => e.number === n && Date.now() - Date.parse(e.addedAt) < 36e5);
            return (
              <button
                key={n}
                onClick={() => onWatchEpisode(n)}
                className={`relative h-[46px] rounded-md bg-[#1c1c1c] hover:bg-[#282828] active:scale-95 transition text-[14px] font-medium ${isCurrent ? "ep-progress" : ""}`}
                title={episodesData.episodes.find((e) => e.number === n)?.title ?? `Episode ${n}`}
              >
                {n}
                {isNew ? (
                  <span className="absolute -top-1 -right-1 bg-[#d32f2f] text-[8px] font-bold px-1 py-[1px] rounded-full">
                    NEW
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}

      {episodesData && numbers.length === 0 ? (
        <p className="px-4 mt-10 text-center text-gray-400 text-sm">No episodes match “{filter}”.</p>
      ) : null}
    </div>
  );
}
