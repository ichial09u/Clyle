"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Radio } from "lucide-react";
import type { AnimeLite } from "@/lib/types";
import PosterCard from "@/components/anime/PosterCard";
import { fetchTop10Month, timeAgo, type Top10MonthEntry } from "@/lib/client-store";

/**
 * "Top 50 This Month" — the See More screen behind the home rail's Top 10.
 *
 * Same live engine as the rail: every open (?fresh=1) schedules a forced
 * Anime Trending re-check server-side; a +5s follow-up pulls the fresh
 * ranking in right away, and a 60s poll keeps the screen current while it
 * sits open. Ranks move as the community vote shifts — each row carries the
 * same NEW / ▲ / ▼ markers the home rail uses, now across all 50 slots.
 */
export default function Top50View({ onBack, onSelect }: { onBack: () => void; onSelect: (a: AnimeLite) => void }) {
  const [items, setItems] = useState<Top10MonthEntry[]>([]);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [gotFirst, setGotFirst] = useState(false); // skeleton only until the FIRST answer (empty/failed must show honestly)
  const lastFetch = useRef(0);

  const refresh = useCallback((fresh = false) => {
    lastFetch.current = Date.now();
    fetchTop10Month(fresh)
      .then((list) => {
        // null = fetch failure — a populated Top 50 must not collapse to the
        // error card on one failed poll; [] (honest empty) still replaces
        if (list) setItems(list);
        setLoadedAt(Date.now());
        setGotFirst(true);
      })
      .catch(() => setGotFirst(true));
  }, []);

  useEffect(() => {
    let followUp: ReturnType<typeof setTimeout> | null = null;
    const open = () => {
      refresh(true);
      if (followUp) clearTimeout(followUp);
      followUp = setTimeout(() => {
        followUp = null;
        if (document.visibilityState === "visible") refresh();
      }, 5_000);
    };
    open();
    const onVis = () => {
      if (document.visibilityState === "visible" && Date.now() - lastFetch.current > 15_000) open();
    };
    document.addEventListener("visibilitychange", onVis);
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 60_000);
    return () => {
      if (followUp) clearTimeout(followUp);
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(poll);
    };
  }, [refresh]);

  return (
    <div className="pb-24">
      {/* header — back arrow + title + live chip */}
      <div className="sticky top-0 z-30 bg-black/90 backdrop-blur-sm" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        <div className="flex items-center gap-3 px-4 py-3">
          <button
            onClick={onBack}
            aria-label="Back"
            className="w-9 h-9 rounded-full bg-[#1a1a1a] border border-[#2a2a2a] flex items-center justify-center active:scale-95 transition"
          >
            <ArrowLeft className="w-4.5 h-4.5 text-white" />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="font-slab text-[19px] font-bold text-white leading-tight">Top 50 This Month</h1>
            <p className="text-[11px] text-gray-500 flex items-center gap-1.5 mt-0.5">
              <Radio className="w-3 h-3 text-red-500 animate-pulse" />
              Live ranking{loadedAt ? <> · updated {timeAgo(new Date(loadedAt).toISOString())}</> : null}
            </p>
          </div>
        </div>
      </div>

      {!items.length && !gotFirst ? (
        <div className="px-4 py-10 space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex gap-3 items-center">
              <div className="w-10 h-[70px] rounded bg-[#161616] animate-pulse" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-2/3 bg-[#161616] rounded animate-pulse" />
                <div className="h-3 w-1/3 bg-[#161616] rounded animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      ) : !items.length ? (
        <div className="px-4 py-10 flex flex-col items-center gap-2.5">
          <p className="text-center text-gray-400 text-[13px]">No ranking available right now — Anime Trending may be busy.</p>
          <button
            onClick={() => refresh(true)}
            className="rounded-full bg-white text-black text-[12.5px] font-semibold px-4 py-2 hover:opacity-90 active:scale-95 transition"
          >
            Try again
          </button>
        </div>
      ) : (
        <ol className="px-4 mt-1">
          {items.map((a) => {
            const prev = a.prevRank;
            const movedUp = prev != null && a.rank < prev;
            const movedDown = prev != null && a.rank > prev;
            const isNew = prev == null;
            return (
              <li key={a.malId}>
                {/* div role=button — PosterCard is itself a <button>; nesting a
                    button inside a button is invalid HTML and React warns */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(a)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(a);
                    }
                  }}
                  className="w-full flex items-center gap-3 py-2 text-left active:bg-[#101010] rounded-lg transition cursor-pointer hover:bg-white/[0.04]"
                >
                  {/* Netflix-style big rank numeral */}
                  <span
                    className="font-slab font-extrabold leading-none w-10 text-right shrink-0 text-[#3a3a3a]"
                    style={{ fontSize: 34, WebkitTextStroke: "1px #6a6a6a", color: a.rank <= 10 ? "#f5c451" : undefined }}
                  >
                    {a.rank}
                  </span>
                  <PosterCard
                    image={a.image}
                    title={a.title}
                    nextEpisodeAt={a.nextEpisodeAt}
                    onClick={() => onSelect(a)}
                    className="w-[52px] h-[74px] shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-[14px] font-semibold text-white truncate">{a.title}</p>
                    <p className="text-[11px] text-gray-500 truncate mt-0.5">
                      {[a.type, a.year, a.score ? `★ ${a.score.toFixed(1)}` : null].filter(Boolean).join(" · ") || "\u00A0"}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1.5 min-h-[16px] text-[11px]">
                      {movedUp ? (
                        <span className="text-red-500 font-bold leading-none">▲ {prev - a.rank} {prev - a.rank === 1 ? "rank" : "ranks"}</span>
                      ) : movedDown ? (
                        <span className="text-gray-500 font-bold leading-none">▼ {a.rank - prev} {a.rank - prev === 1 ? "rank" : "ranks"}</span>
                      ) : isNew ? (
                        <span className="bg-red-600 text-white font-bold px-1 py-[2px] rounded-[3px] text-[9px] leading-none tracking-wide">NEW</span>
                      ) : null}
                    </p>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
