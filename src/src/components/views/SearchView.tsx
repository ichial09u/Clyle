"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Clock, Search, X } from "lucide-react";
import type { AnimeLite } from "@/lib/types";
import PosterCard from "@/components/anime/PosterCard";

/**
 * Recent searches — a device-local recall of what you already looked for.
 * Saved the moment a query actually returns catalog hits (no dead ends),
 * deduped, newest first, capped at 8. Tapping a chip re-runs that search.
 */
const RECENT_KEY = "animetest123.recentsearches";
const RECENT_MAX = 8;

function readRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function writeRecent(list: string[]) {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    /* storage full/blocked — recall is a nicety, never a necessity */
  }
}

export default function SearchView({ onSelect }: { onSelect: (a: AnimeLite) => void }) {
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<AnimeLite[]>([]);
  const [loading, setLoading] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setRecent(readRecent());
  }, []);

  const remember = useCallback((q: string) => {
    setRecent((prev) => {
      const next = [q, ...prev.filter((x) => x !== q)].slice(0, RECENT_MAX);
      writeRecent(next);
      return next;
    });
  }, []);

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
        if ((payload.catalog ?? []).length) remember(query.trim());
      } catch {
        /* keep previous */
      } finally {
        setLoading(false);
      }
    }, 350);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, remember]);

  const hasQuery = query.trim().length >= 2;

  const dropRecent = (q: string) => {
    setRecent((prev) => {
      const next = prev.filter((x) => x !== q);
      writeRecent(next);
      return next;
    });
  };

  const clearRecent = () => {
    setRecent([]);
    writeRecent([]);
  };

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

      {/* Recent searches — shown while the box is empty, one tap back to a
          previous look-up */}
      {!hasQuery && recent.length ? (
        <div className="px-4 mt-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="flex items-center gap-1.5 font-slab text-[15px] font-bold text-gray-200">
              <Clock className="w-[15px] h-[15px] text-gray-500" />
              Recent searches
            </h2>
            <button onClick={clearRecent} className="text-[11.5px] text-gray-500 hover:text-gray-200 transition" aria-label="Clear recent searches">
              Clear
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {recent.map((q) => (
              <span
                key={q}
                className="flex items-center gap-1 bg-[#1c1c1c] hover:bg-[#282828] rounded-full pl-3.5 pr-1.5 py-1.5 text-[13px] text-gray-200 transition"
              >
                <button onClick={() => setQuery(q)} className="max-w-[220px] truncate" aria-label={`Search again for ${q}`}>
                  {q}
                </button>
                <button onClick={() => dropRecent(q)} className="p-1 rounded-full text-gray-500 hover:text-white hover:bg-white/10 transition" aria-label={`Remove ${q} from recent searches`}>
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        </div>
      ) : null}

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
