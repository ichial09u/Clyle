"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, Plus, Check } from "lucide-react";
import type { AnimeLite, SearchResult } from "@/lib/types";
import { minimalLite } from "@/lib/client-store";
import PosterCard from "@/components/anime/PosterCard";

interface GenrePayload {
  genre: string;
  catalog: AnimeLite[];
  suggestions: SearchResult[];
}

export default function GenreView({ genre, onBack, onSelect }: { genre: string; onBack: () => void; onSelect: (a: AnimeLite) => void }) {
  const [data, setData] = useState<{ for: string; payload: GenrePayload } | null>(null);
  const [imported, setImported] = useState<Set<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/genre/${encodeURIComponent(genre)}`);
        const payload = (await res.json()) as GenrePayload;
        if (!cancelled) setData({ for: genre, payload });
      } catch {
        if (!cancelled) setData({ for: genre, payload: { genre, catalog: [], suggestions: [] } });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [genre]);

  const view = data?.for === genre ? data.payload : null;

  async function importOne(malId: number) {
    setImported((prev) => new Set(prev).add(malId));
    await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ malId }),
    }).catch(() => undefined);
  }

  return (
    <div className="pb-24 min-h-screen lg:max-w-[1100px] lg:mx-auto">
      <header className="sticky top-0 z-30 bg-black/95 backdrop-blur flex items-center gap-3 px-3 pt-3 pb-3">
        <button onClick={onBack} className="p-1 -ml-1 hover:opacity-80 active:scale-95 transition" aria-label="Back">
          <ArrowLeft className="w-6 h-6" />
        </button>
        <h1 className="font-slab text-[20px] font-bold">{genre}</h1>
      </header>

      {!view ? (
        <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-6 gap-2 md:gap-3 px-4">
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="aspect-[2/3] rounded-[6px] bg-[#161616] animate-pulse" />
          ))}
        </div>
      ) : (
        <>
          {view.catalog.length ? (
            <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-6 gap-2 md:gap-3 px-4">
              {view.catalog.map((a) => (
                <div key={a.malId}>
                  <PosterCard image={a.image} title={a.title} logo={a.logo} onClick={() => onSelect(a)} className="w-full aspect-[2/3]" />
                  <p className="mt-1 text-[11px] text-gray-400 truncate">{a.title}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="px-4 text-gray-400 text-sm">Nothing in the catalog for this genre yet.</p>
          )}

          {view.suggestions.length ? (
            <>
              <h2 className="font-slab text-[18px] font-bold px-4 mt-7 mb-2.5">
                Popular in this genre <span className="text-[12px] font-normal text-gray-500">— tap + to import from MAL</span>
              </h2>
              <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-6 gap-2 md:gap-3 px-4">
                {view.suggestions.map((s) => (
                  <div key={s.malId}>
                    <div className="relative">
                      <PosterCard
                        image={s.image}
                        title={s.title}
                        onClick={() => importOne(s.malId).then(() => onSelect({ ...minimalLite(s.malId, s.title, s.image), inCatalog: true }))}
                        className="w-full aspect-[2/3]"
                      />
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          importOne(s.malId);
                        }}
                        className={`absolute top-1.5 right-1.5 w-7 h-7 rounded-full flex items-center justify-center transition ${imported.has(s.malId) ? "bg-[#00c853]" : "bg-black/70 hover:bg-black"}`}
                        aria-label={`Import ${s.title}`}
                      >
                        {imported.has(s.malId) ? <Check className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                      </button>
                    </div>
                    <p className="mt-1 text-[11px] text-gray-400 truncate">{s.title}</p>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
