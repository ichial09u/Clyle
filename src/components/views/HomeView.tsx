"use client";

import { useEffect, useState } from "react";
import type { AnimeLite, HomePayload } from "@/lib/types";
import HeroBanner from "@/components/anime/HeroBanner";
import Row from "@/components/anime/Row";
import PosterCard from "@/components/anime/PosterCard";
import { timeAgo } from "@/lib/client-store";

export default function HomeView({
  onSelect,
  onDetails,
  onWatch,
}: {
  onSelect: (a: AnimeLite) => void;
  onDetails: (a: AnimeLite) => void;
  onWatch: (a: AnimeLite) => void;
}) {
  const [data, setData] = useState<HomePayload | null>(null);
  const [heroIdx, setHeroIdx] = useState(0);
  const [error, setError] = useState(false);

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
      <HeroBanner
        anime={hero}
        ctaLabel="Details"
        onCta={() => hero && onDetails(hero)}
        onShare={() => {
          if (!hero) return;
          const url = `https://zokoanime.video/download/mal/${hero.malId}/1/sub`;
          if (navigator.share) navigator.share({ title: hero.title, url }).catch(() => undefined);
          else navigator.clipboard?.writeText(url).catch(() => undefined);
        }}
      />

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

          {/* Top 10 Today — numbered list */}
          {data.top10.length ? (
            <section className="mt-6">
              <h2 className="font-slab text-[21px] font-bold px-4 mb-3">Top 10 Today</h2>
              <div className="flex gap-2 overflow-x-auto no-scrollbar px-4 pb-1">
                {data.top10.map((a, i) => (
                  <div key={a.malId} className="relative shrink-0 text-left active:scale-[0.97] transition">
                    <span className="absolute -left-0.5 -top-1 z-10 font-slab text-[42px] font-extrabold leading-none text-white drop-shadow-[0_2px_2px_rgba(0,0,0,0.9)]">
                      {i + 1}
                    </span>
                    <PosterCard image={a.image} title={a.title} onClick={() => onSelect(a)} className="w-[126px] h-[178px] ml-3" />
                    <p className="mt-1.5 text-[11px] text-gray-300 truncate w-[126px] ml-3">{a.title}</p>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
