"use client";

import { useEffect, useState } from "react";
import type { GenreInfo } from "@/lib/types";

/* Genre tiles — plain text buttons. Every regular genre tile is a BASIC
 * non-colored button with NO icon/emoji (owner requests 2026-10-07: first
 * "basic non color buttons instead of colored ones", then "remove the
 * emojis too") — just the genre name on a neutral dark surface. The old
 * per-genre gradients AND their emoji icons were deliberately retired;
 * do NOT re-introduce either.
 *
 * ⚠️ REGRESSION GUARD — Pokémon is the ONE exception: animated GIF
 * background + cropped classic wordmark overlay, OWNER-APPROVED, keep
 * exactly as-is (it was lost once when a later session reverted it; do NOT
 * "normalize" it away again).
 * e2e-smoke guards the removed Crunchyroll sync route; genre grid itself is
 * asserted only via GET /api/genres (shape). */

export default function GenresView({ onSelect }: { onSelect: (genre: string) => void }) {
  const [genres, setGenres] = useState<GenreInfo[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/genres");
        const payload = (await res.json()) as { genres: GenreInfo[] };
        if (!cancelled) setGenres(payload.genres);
      } catch {
        if (!cancelled) setGenres([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="pb-24 lg:max-w-[1000px] lg:mx-auto">
      <h1 className="font-slab text-[26px] font-extrabold px-4 pt-4 pb-3">Genres</h1>
      <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 md:gap-3 px-4">
        {(genres ?? Array.from({ length: 36 }).map((_, i) => ({ name: `slot-${i}`, count: -1 }))).map((g) =>
          g.count === -1 ? (
            <div key={g.name} className="h-[48px] rounded-md bg-[#161616] animate-pulse" />
          ) : g.name === "Pokémon" ? (
            // Pokémon — the flagship franchise tile (owner-approved, see the
            // regression-guard note at the top of this file): animated scene
            // GIF as the tile background, classic cropped wordmark on top.
            <button
              key={g.name}
              onClick={() => onSelect(g.name)}
              aria-label="Pokémon"
              className="group relative flex h-[48px] items-center justify-center rounded-md overflow-hidden bg-[#12141d] active:scale-95 transition"
            >
              <img
                src="/tiles/pokemon-bg.gif"
                alt=""
                aria-hidden
                draggable={false}
                className="absolute inset-0 h-full w-full object-cover transition duration-200 group-hover:brightness-110"
              />
              <span aria-hidden className="absolute inset-0 bg-gradient-to-t from-black/50 via-black/10 to-black/30" />
              <img
                src="/tiles/pokemon-logo.png"
                alt="Pokémon"
                draggable={false}
                className="relative z-10 h-[26px] w-auto max-w-[86%] object-contain drop-shadow-[0_2px_3px_rgba(0,0,0,0.7)]"
              />
            </button>
          ) : (
            // every genre tile — basic non-colored text-only button (owner
            // request): neutral dark surface, just the genre name
            <button
              key={g.name}
              onClick={() => onSelect(g.name)}
              aria-label={g.name}
              className="h-[48px] rounded-md px-2 flex items-center justify-center bg-[#1d1d1d] ring-1 ring-inset ring-white/10 hover:bg-[#282828] active:scale-95 transition"
            >
              <span className="min-w-0 text-center text-[13px] font-semibold text-gray-100 leading-tight">
                {g.name}
              </span>
            </button>
          )
        )}
      </div>
    </div>
  );
}
