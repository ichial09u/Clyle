"use client";

import { useEffect, useState } from "react";
import type { GenreInfo } from "@/lib/types";

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
            // Pokémon — the flagship franchise tile. The official wordmark
            // artwork IS the label (no text, no count, no glow) so the button
            // pops out of the grid the way the brand does.
            <button
              key={g.name}
              onClick={() => onSelect(g.name)}
              aria-label="Pokémon"
              className="h-[48px] rounded-md px-2 flex items-center justify-center bg-[#12141d] hover:bg-[#1b1f30] active:scale-95 transition"
            >
              <img
                src="/logos/pokemon-wordmark.svg"
                alt="Pokémon"
                draggable={false}
                className="h-[24px] w-auto max-w-full object-contain drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]"
              />
            </button>
          ) : g.name === "OG" ? (
            // OG — the faked niche-classics genre. Styled like a treasure
            // button: polished gold, looping sheen sweep (see .og-tile in
            // globals.css) — deliberately the coolest tile on the grid.
            // No count number — the vault size is a surprise, not a stat.
            <button
              key={g.name}
              onClick={() => onSelect(g.name)}
              aria-label="OG — hidden pre-2010 classics vault"
              className="og-tile h-[48px] rounded-md px-1 text-[13px] font-extrabold tracking-wide leading-tight flex items-center justify-center gap-1"
            >
              <span aria-hidden className="text-[12px] drop-shadow-[0_1px_0_rgba(255,255,255,0.4)]">👑</span>
              OG
            </button>
          ) : (
            <button
              key={g.name}
              onClick={() => onSelect(g.name)}
              className="h-[48px] rounded-md bg-[#1c1c1c] hover:bg-[#282828] active:scale-95 transition px-1 text-[13px] font-medium text-gray-100 leading-tight"
            >
              {g.name}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
