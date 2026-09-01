"use client";

import { useEffect, useState } from "react";
import { Heart } from "lucide-react";
import type { AnimeLite } from "@/lib/types";
import { useMyList } from "@/lib/client-store";
import PosterCard from "@/components/anime/PosterCard";

export default function MyListView({ onSelect }: { onSelect: (a: AnimeLite) => void }) {
  const { malIds, ready } = useMyList();
  const [items, setItems] = useState<AnimeLite[] | null>(null);
  const [idsKey, setIdsKey] = useState<string>("");

  const key = ready ? malIds.join(",") : "";
  useEffect(() => {
    if (!ready || !malIds.length) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/mylist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ malIds }),
        });
        const payload = (await res.json()) as { items: AnimeLite[] };
        if (!cancelled) {
          setItems(payload.items);
          setIdsKey(key);
        }
      } catch {
        if (!cancelled) {
          setItems([]);
          setIdsKey(key);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, key]);

  const effective = ready ? (malIds.length ? (idsKey === key ? items : null) : []) : null;

  return (
    <div className="pb-24">
      <h1 className="font-slab text-[26px] font-extrabold px-4 pt-4 pb-3">My List</h1>

      {!ready || (effective === null && malIds.length) ? (
        <div className="grid grid-cols-3 gap-1.5 px-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="aspect-[2/3] rounded-[6px] bg-[#161616] animate-pulse" />
          ))}
        </div>
      ) : null}

      {ready && effective && effective.length === 0 ? (
        <div className="flex flex-col items-center mt-24 px-8 text-center">
          <Heart className="w-10 h-10 text-[#3a3a3a] mb-3" />
          <p className="text-gray-400 text-sm leading-relaxed">
            Nothing here yet. Tap the <span className="text-white">My List</span> heart on any anime to keep it here.
          </p>
        </div>
      ) : null}

      {effective && effective.length ? (
        <div className="grid grid-cols-3 gap-1.5 px-4">
          {effective.map((a) => (
            <div key={a.malId}>
              <PosterCard image={a.image} title={a.title} logo={a.logo} onClick={() => onSelect(a)} className="w-full aspect-[2/3]" />
              <p className="mt-1 text-[11px] text-gray-400 truncate">{a.title}</p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
