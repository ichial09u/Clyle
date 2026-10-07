"use client";

import { useAiringNow } from "@/lib/airing-tick";
import type { ArrivingEntry } from "@/lib/client-store";

/**
 * "Arriving" — the Netflix-style coming-soon rail.
 *
 * Every scheduled drop for the next three weeks (premieres the season sweep
 * will import + the next episode of anything already airing), in air-time
 * order. Each card carries the same language Netflix's Arriving row uses:
 *   - a tag pill, top-left:  NEW SERIES / NEW MOVIE / EP n
 *   - a countdown chip, top-right: "45 min" / "3 h" / "1 day" — live,
 *     re-rendered by the shared airing clock, flipping red inside 24 h
 *   - the drop date under the title ("Fri, Oct 10", or "Date TBA")
 *
 * Tapping a catalog title opens it like any poster; tapping a premiere the
 * catalog doesn't carry yet lands on DetailsView, which imports it on demand
 * — the same path Web-Push deep links use.
 */

const CARD_W = "w-[126px] md:w-[150px] lg:w-[172px]";
const CARD_H = "h-[178px] md:h-[212px] lg:h-[243px]";

function tagLabel(a: ArrivingEntry): string {
  if (a.kind === "movie") return "NEW MOVIE";
  if (a.kind === "series") return "NEW SERIES";
  return a.episode ? `EP ${a.episode}` : "NEW EPISODE";
}

const TAG_COLORS: Record<ArrivingEntry["kind"], string> = {
  series: "bg-[#d32f2f] text-white", // Netflix red — premieres
  movie: "bg-[#b45309] text-white", // amber — movies
  episode: "bg-[#263445] text-gray-100", // slate — episode drops
};

function countdownText(airingAt: number, now: number): string | null {
  const ms = airingAt * 1000 - now;
  if (ms <= 0) return null; // already dropped — chip hides
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  return `${d} day${d > 1 ? "s" : ""}`;
}

function dateLine(airingAt: number | null): string {
  if (!airingAt) return "Date TBA";
  return new Date(airingAt * 1000).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export default function ArrivingRail({
  items,
  onSelect,
}: {
  items: ArrivingEntry[];
  onSelect: (a: ArrivingEntry) => void;
}) {
  const now = useAiringNow();
  if (!items.length) return null;

  return (
    <section className="mt-6">
      <div className="px-4 mb-3">
        <h2 className="font-slab text-[21px] font-bold">Arriving</h2>
        <p className="text-[11px] text-gray-500 mt-0.5">New series, new movies and new episodes — on the day they drop</p>
      </div>
      <div className="flex gap-2 overflow-x-auto no-scrollbar px-4 pb-1">
        {items.map((a) => {
          const cd = a.airingAt ? countdownText(a.airingAt, now) : null;
          const soon = cd != null && (a.airingAt ?? 0) * 1000 - now <= 24 * 3600_000;
          return (
            <div key={`${a.malId}:${a.kind}:${a.episode ?? 0}`} className={`shrink-0 ${CARD_W}`}>
              <button
                onClick={() => onSelect(a)}
                aria-label={a.title}
                title={a.title}
                className={`relative block w-full ${CARD_H} overflow-hidden rounded-[6px] bg-[#161616] text-left active:scale-[0.97] hover:opacity-90 transition`}
              >
                {a.image ? (
                  <img
                    src={a.image}
                    alt={a.title}
                    loading="lazy"
                    draggable={false}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-end p-2">
                    <span className="font-slab text-[12px] leading-tight text-gray-300 line-clamp-3">{a.title}</span>
                  </div>
                )}
                <span className={`absolute top-1 left-1 text-[9px] font-bold px-1.5 py-[2px] rounded ${TAG_COLORS[a.kind]}`}>
                  {tagLabel(a)}
                </span>
                {cd ? (
                  <span
                    className={`absolute top-1 right-1 text-[9px] font-bold px-1.5 py-[2px] rounded ${
                      soon ? "bg-[#d32f2f] text-white" : "bg-black/75 text-white"
                    }`}
                  >
                    {cd}
                  </span>
                ) : null}
              </button>
              <p className="mt-1.5 text-[11px] text-gray-300 truncate">{a.title}</p>
              <p className="mt-0.5 text-[10px] text-gray-500">{dateLine(a.airingAt)}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
