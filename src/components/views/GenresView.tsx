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
