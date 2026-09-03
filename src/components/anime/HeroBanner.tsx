"use client";

import { useState } from "react";
import { Heart } from "lucide-react";
import type { AnimeLite } from "@/lib/types";
import { useMyList } from "@/lib/client-store";
import { artUrl } from "@/lib/art";

interface HeroBannerProps {
  /** All hero slides; `index` is the active one. Backdrops crossfade between slides. */
  items: AnimeLite[];
  index: number;
  ctaLabel: "Details" | "Watch";
  onCta: () => void;
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

type ArtStatus = "loading" | "loaded" | "error";

export default function HeroBanner({ items, index, ctaLabel, onCta }: HeroBannerProps) {
  const { has, toggle } = useMyList();
  // defensive: props can arrive unsettled during fast-refresh/dev transitions
  const list = Array.isArray(items) ? items : [];
  const anime = list[index] ?? null;
  // hand-rolled minimal anime objects (MAL import cards, related titles) can
  // lack array fields — never trust genres to exist
  const genres = anime && Array.isArray(anime.genres) ? anime.genres : [];

  /* ---------- backdrop load tracking (the desktop background fix) ----------
   * The hero used to crossfade purely on `index`: the moment the rotation
   * moved on, the new slide's <img> got opacity 1 even if its file hadn't
   * loaded yet (slow/filtered CDNs are common on desktop browsers, e.g.
   * school Chromebooks blocking AniList's CDN). Result: the background
   * seemed to show one image once and never follow the featured anime.
   *
   * Now every slide's art is load-tracked (through the same-origin /api/art
   * proxy), and the VISIBLE backdrop is always a slide that has actually
   * decoded — the active one as soon as it's ready, the previous good one
   * until then, never a blank frame. Broken URLs are dropped from the
   * rotation entirely.
   *
   * Status is keyed by URL and deliberately NEVER reset: URLs are
   * content-addressed, so a slide list refresh that reuses a URL reuses its
   * still-valid loaded state, and only genuinely new URLs start loading. */
  const [status, setStatus] = useState<Record<string, ArtStatus>>({});
  const srcs = list.map((it) => artUrl(it.banner || it.image));

  const mark = (src: string, next: ArtStatus) =>
    setStatus((s) => (s[src] === next ? s : { ...s, [src]: next }));

  /** The slide whose art is actually on screen (−1 = nothing loaded yet). */
  let shownIdx = -1;
  for (let i = index; i >= 0; i--) {
    const s = srcs[i];
    if (s && status[s] === "loaded") {
      shownIdx = i;
      break;
    }
  }
  if (shownIdx === -1) {
    for (let i = 0; i < srcs.length; i++) {
      const s = srcs[i];
      if (s && status[s] === "loaded") {
        shownIdx = i;
        break;
      }
    }
  }

  if (!anime) {
    return <div className="h-[470px] md:h-[560px] lg:h-[640px] bg-black animate-pulse" />;
  }
  const inList = has(anime.malId);

  return (
    <div className="relative w-full h-[470px] md:h-[560px] lg:h-[640px] overflow-hidden bg-[#0a0a0a]">
      {/* backdrop — all slides stacked, opacity crossfades between LOADED ones */}
      {list.map((it, i) => {
        const src = srcs[i];
        if (!src || status[src] === "error") return null;
        return (
          <img
            key={`${it.malId}-${i}`}
            src={src}
            alt=""
            draggable={false}
            decoding="async"
            onLoad={() => mark(src, "loaded")}
            onError={() => mark(src, "error")}
            className="absolute inset-0 w-full h-full object-cover transition-opacity duration-1000 ease-in-out"
            style={{ opacity: i === shownIdx ? 1 : 0 }}
          />
        );
      })}
      <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-black/35 to-black" />

      {/* content */}
      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center text-center px-4 pb-3">
        <h1 className="font-slab text-[26px] md:text-[32px] lg:text-[40px] leading-tight font-bold text-white drop-shadow-lg max-w-[92%] lg:max-w-[80%]">
          {anime.title}
        </h1>

        <div className="flex items-center gap-1.5 mt-2">
          {anime.type ? <Badge kind="type">{anime.type.toUpperCase()}</Badge> : null}
          {anime.ratingShort && anime.ratingShort !== "None" ? <Badge kind="rating">{anime.ratingShort}</Badge> : null}
          {anime.score ? <Badge kind="score">{anime.score.toFixed(1)}</Badge> : null}
        </div>

        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 mt-2.5 text-[13px] md:text-[14.5px] text-gray-200">
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

        {genres.length ? (
          <div className="mt-1.5 text-[13px] md:text-[14.5px] text-gray-200">{genres.slice(0, 3).join(", ")}</div>
        ) : null}

        {/* action row — Details pill centered (reference layout), My List right.
            Share was removed: an empty first grid cell keeps the pill truly
            centered exactly like the reference app. */}
        <div className="mt-4 mb-1 w-full max-w-[360px] md:max-w-[430px] grid grid-cols-3 items-center">
          <span aria-hidden className="flex flex-col items-center" />

          <button
            onClick={onCta}
            className="justify-self-center flex items-center gap-2.5 bg-white text-black font-bold text-[17px] md:text-[19px] rounded-full px-10 py-3 md:px-12 md:py-3.5 hover:bg-gray-200 active:scale-95 transition shadow-[0_4px_18px_rgba(0,0,0,0.55)]"
          >
            {ctaLabel === "Watch" ? (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            ) : (
              /* filled ⓘ — matches the reference app's solid info badge */
              <svg width="17" height="17" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" fill="currentColor" />
                <rect x="10.9" y="10" width="2.2" height="7" rx="1.1" fill="#fff" />
                <circle cx="12" cy="7" r="1.3" fill="#fff" />
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
