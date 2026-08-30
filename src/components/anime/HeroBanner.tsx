"use client";

import { Heart, Share2 } from "lucide-react";
import type { AnimeLite } from "@/lib/types";
import { useMyList } from "@/lib/client-store";

interface HeroBannerProps {
  /** All hero slides; `index` is the active one. Backdrops crossfade between slides. */
  items: AnimeLite[];
  index: number;
  ctaLabel: "Details" | "Watch";
  onCta: () => void;
  onShare: () => void;
}

function Badge({ kind, children }: { kind: "type" | "rating" | "score"; children: React.ReactNode }) {
  const cls =
    kind === "rating"
      ? "bg-[#d32f2f] text-white"
      : kind === "score"
        ? "bg-white text-black"
        : "bg-[#2b2b2b] text-white border border-[#3a3a3a]";
  return <span className={`${cls} px-1.5 py-[1px] rounded text-[10px] font-bold tracking-wide`}>{children}</span>;
}

export default function HeroBanner({ items, index, ctaLabel, onCta, onShare }: HeroBannerProps) {
  const { has, toggle } = useMyList();
  const anime = items[index] ?? null;
  if (!anime) {
    return <div className="h-[470px] bg-black animate-pulse" />;
  }
  const inList = has(anime.malId);

  return (
    <div className="relative w-full h-[470px] overflow-hidden bg-[#0a0a0a]">
      {/* backdrop — all slides stacked, opacity crossfades between them */}
      {items.map((it, i) => {
        const src = it.banner || it.image;
        if (!src) return null;
        return (
          <img
            key={`${it.malId}-${i}`}
            src={src}
            alt=""
            draggable={false}
            className="absolute inset-0 w-full h-full object-cover transition-opacity duration-1000 ease-in-out"
            style={{ opacity: i === index ? 1 : 0 }}
          />
        );
      })}
      <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-black/35 to-black" />

      {/* content */}
      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center text-center px-4 pb-3">
        <h1 className="font-slab text-[26px] leading-tight font-bold text-white drop-shadow-lg max-w-[92%]">
          {anime.title}
        </h1>

        <div className="flex items-center gap-1.5 mt-2">
          {anime.type ? <Badge kind="type">{anime.type.toUpperCase()}</Badge> : null}
          {anime.ratingShort && anime.ratingShort !== "None" ? <Badge kind="rating">{anime.ratingShort}</Badge> : null}
          {anime.score ? <Badge kind="score">{anime.score.toFixed(1)}</Badge> : null}
        </div>

        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 mt-2.5 text-[13px] text-gray-200">
          {anime.season || anime.year ? (
            <span>
              {anime.season ?? ""} {anime.year ?? ""}
            </span>
          ) : null}
          <span>{anime.status ?? (anime.airing ? "Currently Airing" : "Finished Airing")}</span>
          {anime.durationMin ? <span>{anime.durationMin}m</span> : null}
          <span className="flex items-center gap-1">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="#cfcfcf">
              <path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7L12 17.3 5.8 20.9l1.6-7L2 9.2l7.1-.6L12 2z" />
            </svg>
            {anime.score?.toFixed(1) ?? "—"}
          </span>
        </div>

        {anime.genres.length ? (
          <div className="mt-1.5 text-[13px] text-gray-200">{anime.genres.slice(0, 3).join(", ")}</div>
        ) : null}

        {/* action row */}
        <div className="mt-4 mb-1 w-full max-w-[360px] grid grid-cols-3 items-center">
          <button
            onClick={onShare}
            className="flex flex-col items-center gap-1 text-gray-200 hover:text-white active:scale-95 transition"
            aria-label="Share"
          >
            <Share2 className="w-5 h-5" />
            <span className="text-[11px]">Share</span>
          </button>

          <button
            onClick={onCta}
            className="justify-self-center flex items-center gap-2 bg-white text-black font-bold text-[15px] rounded-full px-7 py-2.5 hover:bg-gray-200 active:scale-95 transition shadow-lg"
          >
            {ctaLabel === "Watch" ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-5M12 8h.01" />
              </svg>
            )}
            {ctaLabel}
          </button>

          <button
            onClick={() => toggle(anime)}
            className={`flex flex-col items-center gap-1 hover:text-white active:scale-95 transition ${inList ? "text-[#ff5252]" : "text-gray-200"}`}
            aria-label={inList ? "Remove from My List" : "Add to My List"}
          >
            <Heart className={`w-5 h-5 ${inList ? "fill-current" : ""}`} />
            <span className="text-[11px]">My List</span>
          </button>
        </div>
      </div>
    </div>
  );
}
