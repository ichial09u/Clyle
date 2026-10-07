"use client";

import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import type { AnimeLite } from "@/lib/types";
import PosterCard from "@/components/anime/PosterCard";

export default function SearchView({ onSelect }: { onSelect: (a: AnimeLite) => void }) {
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<AnimeLite[]>([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (query.trim().length < 2) {
      setCatalog([]);
      return;
    }
    setLoading(true);
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}`);
        const payload = (await res.json()) as { catalog: AnimeLite[] };
        setCatalog(payload.catalog ?? []);
      } catch {
        /* keep previous */
      } finally {
        setLoading(false);
      }
    }, 350);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query]);

  const hasQuery = query.trim().length >= 2;

  return (
    <div className="pb-24 lg:max-w-[1200px] lg:mx-auto">
      <h1 className="font-slab text-[26px] font-extrabold px-4 pt-4 pb-3">Search</h1>
      <div className="px-4">
        <div className="flex items-center bg-[#1c1c1c] rounded-[10px] px-3.5 h-[46px]">
          <Search className="w-[18px] h-[18px] text-gray-400 mr-2.5" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="flex-1 bg-transparent outline-none text-[15px] placeholder:text-gray-500"
            aria-label="Search anime"
          />
          {query ? (
            <button onClick={() => setQuery("")} aria-label="Clear search">
              <X className="w-[18px] h-[18px] text-gray-400" />
            </button>
          ) : null}
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-6 gap-1.5 md:gap-2.5 px-4 mt-4">
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="aspect-[2/3] rounded-[6px] bg-[#161616] animate-pulse" />
          ))}
        </div>
      ) : null}

      {!loading && hasQuery && catalog.length === 0 ? (
        <p className="px-4 mt-10 text-center text-gray-400 text-sm">No results for “{query}”.</p>
      ) : null}

      {!loading && catalog.length ? (
        <>
          <h2 className="font-slab text-[16px] font-bold px-4 mt-5 mb-2">In catalog</h2>
          <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-6 gap-1.5 md:gap-2.5 px-4">
            {catalog.map((a) => (
              <div key={a.malId}>
                <PosterCard image={a.image} title={a.title} onClick={() => onSelect(a)} className="w-full aspect-[2/3]" />
                <p className="mt-1 text-[11px] text-gray-400 truncate">{a.title}</p>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
