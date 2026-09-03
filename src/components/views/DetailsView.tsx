"use client";

import { useEffect, useState } from "react";
import type { AnimeLite, DetailsPayload, RelatedCard } from "@/lib/types";
import HeroBanner from "@/components/anime/HeroBanner";
import PosterCard from "@/components/anime/PosterCard";
import CommentsSection from "@/components/anime/CommentsSection";
import { useMyList, minimalLite } from "@/lib/client-store";

export default function DetailsView({
  anime: initial,
  onWatch,
  onEpisodes,
  onSelect,
  onBack,
}: {
  anime: AnimeLite;
  onWatch: (a: AnimeLite) => void;
  onEpisodes: (a: AnimeLite) => void;
  onSelect: (a: AnimeLite) => void;
  onBack: () => void;
}) {
  const [data, setData] = useState<{ for: number; payload: DetailsPayload } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [importing, setImporting] = useState(false);
  const { has, toggle } = useMyList();

  useEffect(() => {
    let cancelled = false;
    setExpanded(false);
    const grab = async (): Promise<DetailsPayload | null> => {
      try {
        const res = await fetch(`/api/anime/${initial.malId}`);
        if (!res.ok) return null; // rate-limited / transient — try again
        return (await res.json()) as DetailsPayload;
      } catch {
        return null; // network hiccup — keep hero data
      }
    };
    (async () => {
      // When the viewer taps an import card (search/genre), the import POST is
      // still running server-side and /api/anime can fail or come back empty —
      // poll briefly so the page fills in live instead of staying skeletal.
      for (let attempt = 0; attempt < 24 && !cancelled; attempt++) {
        const payload = await grab();
        if (cancelled) return;
        if (payload?.anime) {
          setData({ for: initial.malId, payload });
          return;
        }
        await new Promise((r) => setTimeout(r, 2_500));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initial.malId]);

  const details = data?.for === initial.malId ? data.payload : null;

  const anime = details?.anime ?? initial;
  const inList = has(anime.malId);
  const inCatalog = anime.inCatalog;

  async function importAnime() {
    setImporting(true);
    try {
      await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ malId: anime.malId }),
      });
      window.location.reload();
    } finally {
      setImporting(false);
    }
  }

  const relatedCard = (r: RelatedCard) => (
    <button
      key={`${r.relation}-${r.malId}`}
      onClick={() =>
        r.malId &&
        onSelect({
          ...minimalLite(r.malId, r.name, r.image),
          inCatalog: r.inCatalog,
        })
      }
      className="relative shrink-0 w-[190px] h-[96px] md:w-[220px] md:h-[110px] rounded-[6px] overflow-hidden bg-[#161616] active:scale-[0.97] transition"
    >
      {r.image ? (
        <img src={r.image} alt={r.name} loading="lazy" className="absolute inset-0 w-full h-full object-cover opacity-45" />
      ) : null}
      <div className="absolute inset-0 flex flex-col items-center justify-center px-2 text-center">
        <span className="font-slab text-[15px] font-bold text-white drop-shadow">{r.relation ?? "Related"}</span>
        <span className="text-[10px] text-gray-300 line-clamp-1 max-w-full mt-0.5">{r.name}</span>
      </div>
    </button>
  );

  return (
    <div className="pb-24">
      {/* top bar */}
      {/* top bar — spans the content area right of the lg nav rail */}
      <div className="fixed top-0 inset-x-0 z-30 max-w-[560px] md:max-w-[820px] lg:max-w-none lg:left-[76px] mx-auto">
        <button
          onClick={onBack}
          className="m-3 w-9 h-9 rounded-full bg-black/50 backdrop-blur flex items-center justify-center hover:bg-black/70 transition"
          aria-label="Back"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
      </div>

      <HeroBanner
        items={[anime]}
        index={0}
        ctaLabel="Watch"
        onCta={() => onWatch(anime)}
      />

      <div className="px-4 lg:max-w-[1100px] lg:mx-auto">
        {/* synopsis */}
        {anime.synopsis ? (
          <p className={`mt-4 text-[13.5px] leading-relaxed text-gray-200 ${expanded ? "" : "line-clamp-4"}`}>
            {anime.synopsis}
          </p>
        ) : null}
        {anime.synopsis && anime.synopsis.length > 220 ? (
          <button onClick={() => setExpanded((e) => !e)} className="mt-1 text-[12px] text-gray-400 hover:text-white">
            {expanded ? "Show less" : "Read more"}
          </button>
        ) : null}

        {!inCatalog ? (
          <button
            onClick={importAnime}
            disabled={importing}
            className="mt-4 w-full rounded-md bg-[#d32f2f] hover:bg-[#b71c1c] disabled:opacity-60 text-white text-[14px] font-bold py-2.5 transition"
          >
            {importing ? "Importing from MAL…" : "Not in catalog yet — Import now (free, instant)"}
          </button>
        ) : null}

        {/* Other Seasons */}
        {details?.otherSeasons?.length ? (
          <section className="mt-6">
            <h2 className="font-slab text-[21px] font-bold mb-2.5">Other Seasons</h2>
            <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">{details.otherSeasons.map(relatedCard)}</div>
          </section>
        ) : null}

        {/* episodes shortcut */}
        {inCatalog ? (
          <button
            onClick={() => onEpisodes(anime)}
            className="mt-6 w-full flex items-center justify-between rounded-md bg-[#161616] hover:bg-[#1f1f1f] px-4 py-3 transition"
          >
            <span className="font-slab font-bold text-[15px]">Episodes</span>
            <span className="text-[12px] text-gray-400">
              {anime.totalEpisodes ? `${anime.totalEpisodes} episodes` : "Browse"}
            </span>
          </button>
        ) : null}

        {/* You May Also Like */}
        {details?.similar?.length ? (
          <section className="mt-6">
            <h2 className="font-slab text-[21px] font-bold mb-2.5">You May Also Like</h2>
            <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-6 gap-2 md:gap-2.5">
              {details.similar.slice(0, 9).map((r) => (
                <div key={r.malId} className="relative">
                  <PosterCard
                    image={r.image}
                    title={r.name}
                    onClick={() => onSelect({ ...minimalLite(r.malId, r.name, r.image), inCatalog: r.inCatalog })}
                    className="w-full aspect-[2/3]"
                  />
                  {!r.inCatalog ? (
                    <span className="absolute bottom-1 right-1 bg-black/70 text-[9px] text-gray-300 px-1 rounded">
                      importable
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>

      {/* community comments */}
      <CommentsSection malId={anime.malId} />
    </div>
  );
}
