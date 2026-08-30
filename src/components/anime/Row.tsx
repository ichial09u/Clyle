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
          <button onClick={onMore} className="text-gray-400 hover:text-white transition" aria-label={`More ${title}`}>
            <ChevronRight className="w-5 h-5" />
          </button>
        ) : null}
      </div>
      <div ref={scroller} className="flex gap-2 overflow-x-auto no-scrollbar px-4 pb-1" style={{ scrollbarWidth: "none" }}>
        {items.map((a) => (
          <PosterCard
            key={`${title}-${a.malId}`}
            image={a.image}
            title={a.title}
            onClick={() => onSelect(a)}
            className="w-[126px] h-[178px]"
          />
        ))}
      </div>
    </section>
  );
}
