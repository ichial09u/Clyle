"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AnimeLite, ContinueItem, HomePayload } from "@/lib/types";
import HeroBanner from "@/components/anime/HeroBanner";
import Row from "@/components/anime/Row";
import PosterCard from "@/components/anime/PosterCard";
import ContinueRow from "@/components/anime/ContinueRow";
import Top10Bell from "@/components/anime/Top10Bell";
import {
  loadContinueItems, removeProgress, timeAgo, useProgressVersion,
  fetchWatchTimeTop, localDayKey, subscribeWatchTime, type TopWatchEntry,
} from "@/lib/client-store";

/** "3h 24m watched" style caption under each Top 10 Today card. */
function fmtWatched(s: number): string {
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m ? `${h}h ${m}m watched` : `${h}h watched`;
  }
  if (s >= 60) return `${Math.floor(s / 60)}m watched`;
  return "just started";
}

export default function HomeView({
  onSelect,
  onDetails,
  onWatch,
  onResume,
}: {
  onSelect: (a: AnimeLite) => void;
  onDetails: (a: AnimeLite) => void;
  onWatch: (a: AnimeLite) => void;
  onResume: (item: ContinueItem) => void;
}) {
  const [data, setData] = useState<HomePayload | null>(null);
  const [heroIdx, setHeroIdx] = useState(0);
  const [error, setError] = useState(false);
  const [continueItems, setContinueItems] = useState<ContinueItem[]>([]);
  const [top10, setTop10] = useState<TopWatchEntry[]>([]);
  const progressVersion = useProgressVersion();
  const lastTop10Fetch = useRef(0);

  const refreshContinue = useCallback(() => {
    loadContinueItems().then(setContinueItems).catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshContinue();
  }, [refreshContinue, progressVersion]);

  // Top 10 Today — ranked purely by how long people ACTUALLY watched today
  // (server aggregates every viewer; local buckets keep it instant + offline).
  // Stays empty until someone watches an episode of an anime.
  const refreshTop10 = useCallback(() => {
    lastTop10Fetch.current = Date.now();
    fetchWatchTimeTop(localDayKey()).then(setTop10).catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshTop10();
    const unsub = subscribeWatchTime(() => {
      // the player accrues every ~5-10s; re-rank at most every 15s
      if (Date.now() - lastTop10Fetch.current > 15_000) refreshTop10();
    });
    const onVis = () => {
      if (document.visibilityState === "visible") refreshTop10();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      unsub();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refreshTop10]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/home");
        if (!res.ok) throw new Error(String(res.status));
        const payload = (await res.json()) as HomePayload;
        if (!cancelled) setData(payload);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // auto-rotate the hero like a spotlight
  useEffect(() => {
    if (!data?.hero?.length || data.hero.length < 2) return;
    const t = setInterval(() => setHeroIdx((i) => (i + 1) % data.hero.length), 9000);
    return () => clearInterval(t);
  }, [data]);

  // background auto-sync: pull new episodes when the app opens (throttled server-side)
  useEffect(() => {
    const t = setTimeout(() => {
      fetch("/api/sync", { method: "POST" }).catch(() => undefined);
    }, 2500);
    return () => clearTimeout(t);
  }, []);

  const hero = data?.hero?.[heroIdx] ?? null;

  return (
    <div className="pb-24">
      {/* Top 10 notifications — floating bell (unread badge) over the hero */}
      <Top10Bell onSelect={onSelect} />

      <HeroBanner
        items={data?.hero ?? []}
        index={heroIdx}
        ctaLabel="Details"
        onCta={() => hero && onDetails(hero)}
        onShare={() => {
          if (!hero) return;
          const url = `https://zokoanime.video/download/mal/${hero.malId}/1/sub`;
          if (navigator.share) navigator.share({ title: hero.title, url }).catch(() => undefined);
          else navigator.clipboard?.writeText(url).catch(() => undefined);
        }}
      />

      {/* Continue Watching — resumes the exact episode + second */}
      {continueItems.length ? (
        <ContinueRow
          items={continueItems.slice(0, 12)}
          onResume={onResume}
          onRemove={(malId) => {
            removeProgress(malId);
            setContinueItems((items) => items.filter((i) => i.malId !== malId));
          }}
        />
      ) : null}

      {error ? (
        <p className="px-4 mt-8 text-center text-gray-400 text-sm">
          Could not reach the catalog. MAL API may be busy — pull to retry in a moment.
        </p>
      ) : null}

      {!data && !error ? (
        <div className="flex gap-2 px-4 mt-6">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="w-[126px] h-[178px] rounded-[6px] bg-[#161616] animate-pulse" />
          ))}
        </div>
      ) : null}

      {data ? (
        <>
          {data.lastSync.at ? (
            <p className="px-4 mt-2 text-[11px] text-gray-500">Catalog updated {timeAgo(data.lastSync.at)}</p>
          ) : null}
          {data.sections.map((s) => (
            <Row key={s.key} title={s.title} items={s.items} onSelect={onSelect} />
          ))}
        </>
      ) : null}

      {/* Top 10 Today — ranked by real watch time; hidden until someone watches */}
      {top10.length ? (
        <section className="mt-6">
          <h2 className="font-slab text-[21px] font-bold px-4 mb-3">Top 10 Today</h2>
          <div className="flex gap-2 overflow-x-auto no-scrollbar px-4 pb-1">
            {top10.map((a, i) => (
              <div key={a.malId} className="relative shrink-0 text-left active:scale-[0.97] transition">
                <span className="absolute -left-0.5 -top-1 z-10 font-slab text-[42px] font-extrabold leading-none text-white drop-shadow-[0_2px_2px_rgba(0,0,0,0.9)]">
                  {i + 1}
                </span>
                <PosterCard image={a.image} title={a.title} onClick={() => onSelect(a)} className="w-[126px] h-[178px] ml-3" />
                <p className="mt-1.5 text-[11px] text-gray-300 truncate w-[126px] ml-3">{a.title}</p>
                <p className="mt-0.5 text-[10px] ml-3 flex items-center gap-1 min-h-[16px]">
                  {a.isNew ? (
                    <span className="shrink-0 bg-red-600 text-white font-bold px-1 py-[2px] rounded-[3px] text-[9px] leading-none tracking-wide">
                      NEW
                    </span>
                  ) : a.weeksInTop10 && a.weeksInTop10 > 0 ? (
                    <span
                      title={`${a.weeksInTop10} week${a.weeksInTop10 > 1 ? "s" : ""} in the Top 10`}
                      className="shrink-0 bg-red-600 text-white font-bold px-1 py-[2px] rounded-[3px] text-[9px] leading-none tracking-wide"
                    >
                      {a.weeksInTop10}w in Top 10
                    </span>
                  ) : null}
                  <span className="text-gray-500 truncate">{fmtWatched(a.seconds)}</span>
                </p>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
