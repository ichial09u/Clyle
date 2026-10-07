"use client";

import { useEffect, useState } from "react";
import type { GenreInfo } from "@/lib/types";

/* Per-genre tile identity — every regular genre tile gets its own dark-to-
 * bright gradient + icon so the grid reads as a themed board. Colors are
 * dark→saturated on purpose: white labels keep AA contrast on every stop.
 *
 * ⚠️ REGRESSION GUARD — these two bespoke tiles are OWNER-APPROVED and must
 * survive every future redesign (they were lost once when a later session
 * reverted them; do NOT "normalize" them away again):
 *   • Pokémon  = animated GIF background + cropped classic wordmark overlay
 *   • OG       = same gradient-tile structure as the rest (👑 + gold)
 * e2e-smoke asserts both (assets 200 + markup present). */
const GENRE_TILES: Record<string, { icon: string; g: [string, string] }> = {
  Action: { icon: "⚡", g: ["#7f1d1d", "#dc2626"] },
  Adventure: { icon: "🧭", g: ["#7c2d12", "#ea580c"] },
  Comedy: { icon: "😂", g: ["#713f12", "#ca8a04"] },
  Drama: { icon: "🎭", g: ["#4c0519", "#be123c"] },
  Fantasy: { icon: "🐉", g: ["#4c1d95", "#8b5cf6"] },
  Horror: { icon: "👻", g: ["#450a0a", "#991b1b"] },
  "Mahou Shoujo": { icon: "🪄", g: ["#831843", "#db2777"] },
  Mecha: { icon: "🤖", g: ["#292524", "#78716c"] },
  Military: { icon: "🎖️", g: ["#1c1917", "#57534e"] },
  Music: { icon: "🎵", g: ["#701a75", "#c026d3"] },
  Mystery: { icon: "🕵️", g: ["#292524", "#57534e"] },
  Psychological: { icon: "🧠", g: ["#3b0764", "#9333ea"] },
  Romance: { icon: "💗", g: ["#4c0519", "#f43f5e"] },
  School: { icon: "🎒", g: ["#14532d", "#16a34a"] },
  "Sci-Fi": { icon: "🚀", g: ["#134e4a", "#0d9488"] },
  "Slice of Life": { icon: "🍃", g: ["#365314", "#65a30d"] },
  Sports: { icon: "🏆", g: ["#7c2d12", "#f59e0b"] },
  "Super Power": { icon: "💥", g: ["#7c2d12", "#ef4444"] },
  Supernatural: { icon: "🔮", g: ["#4c1d95", "#a855f7"] },
  Thriller: { icon: "🗡️", g: ["#1c1917", "#44403c"] },
  Ecchi: { icon: "🌶️", g: ["#831843", "#e11d48"] },
  Isekai: { icon: "🌀", g: ["#134e4a", "#14b8a6"] },
  Historical: { icon: "🏯", g: ["#451a03", "#b45309"] },
  Space: { icon: "🪐", g: ["#2e1065", "#6d28d9"] },
  Vampire: { icon: "🦇", g: ["#450a0a", "#b91c1c"] },
  Harem: { icon: "💘", g: ["#500724", "#ec4899"] },
  OG: { icon: "👑", g: ["#713f12", "#eab308"] },
};

const TILE_FALLBACK = { icon: "📺", g: ["#1c1c1c", "#282828"] } as const;

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
          ) : (() => {
            // every genre tile — themed gradient + icon (OG included: same
            // structure as the rest, gold crown gradient as its identity)
            const tile = GENRE_TILES[g.name] ?? TILE_FALLBACK;
            return (
              <button
                key={g.name}
                onClick={() => onSelect(g.name)}
                aria-label={g.name}
                className="h-[48px] rounded-md px-2 flex items-center justify-center gap-1.5 ring-1 ring-inset ring-white/10 hover:brightness-110 active:scale-95 transition"
                style={{ background: `linear-gradient(135deg, ${tile.g[0]} 0%, ${tile.g[1]} 100%)` }}
              >
                <span aria-hidden className="shrink-0 text-[14px] leading-none drop-shadow-[0_1px_1px_rgba(0,0,0,0.6)]">
                  {tile.icon}
                </span>
                <span className="min-w-0 text-center text-[13px] font-semibold text-white leading-tight drop-shadow-[0_1px_1px_rgba(0,0,0,0.5)]">
                  {g.name}
                </span>
              </button>
            );
          })()
        )}
      </div>
    </div>
  );
}
