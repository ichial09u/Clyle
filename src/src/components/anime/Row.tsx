"use client";

import { useRef } from "react";
import { ChevronRight } from "lucide-react";
import type { AnimeLite } from "@/lib/types";
import PosterCard from "./PosterCard";

export default function Row({
  title,
  items,
  onSelect,
  onMore,
}: {
  title: string;
  items: AnimeLite[];
  onSelect: (a: AnimeLite) => void;
  onMore?: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  if (!items.length) return null;

  return (
    <section className="mt-5">
      <div className="flex items-center justify-between px-4 mb-2.5">
        <h2 className="font-slab text-[21px] font-bold">{title}</h2>
        {onMore ? (
          <button onClick={onMore} className="flex items-center gap-0.5 text-[12px] font-semibold text-gray-400 hover:text-white active:scale-95 transition pb-0.5" aria-label={`See more ${title}`}>
            See More
            <ChevronRight className="w-4 h-4" />
          </button>
        ) : null}
      </div>
      <div ref={scroller} className="flex gap-2 overflow-x-auto no-scrollbar px-4 pb-1" style={{ scrollbarWidth: "none" }}>
        {items.map((a) => (
          <PosterCard
            key={`${title}-${a.malId}`}
            image={a.image}
            title={a.title}

            nextEpisodeAt={a.nextEpisodeAt}
            onClick={() => onSelect(a)}
            className="w-[126px] h-[178px] md:w-[150px] md:h-[212px] lg:w-[172px] lg:h-[243px]"
          />
        ))}
      </div>
    </section>
  );
}
