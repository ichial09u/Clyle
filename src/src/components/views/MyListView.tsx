"use client";

import { useEffect, useRef, useState } from "react";
import { Heart } from "lucide-react";
import type { AnimeLite } from "@/lib/types";
import { minimalLite, outboxSend, useMyList } from "@/lib/client-store";
import PosterCard from "@/components/anime/PosterCard";

export default function MyListView({ onSelect }: { onSelect: (a: AnimeLite) => void }) {
  const { list, malIds, ready } = useMyList();
  const [items, setItems] = useState<AnimeLite[] | null>(null);
  const [idsKey, setIdsKey] = useState<string>("");
  // local entries mirror the ids — the offline fallback renders from these
  const listRef = useRef(list);
  listRef.current = list;

  const key = ready ? malIds.join(",") : "";
  useEffect(() => {
    if (!ready || !malIds.length) return;
    let cancelled = false;
    (async () => {
      // outbox-routed: offline the POST is parked and replayed on reconnect
      // (keeps the server-side list hydrated), but the grid renders either way
      const res = await outboxSend("mylist", "/api/mylist", "POST", JSON.stringify({ malIds })).catch(() => null);
      if (cancelled) return;
      if (res && res.ok) {
        try {
          const payload = (await res.json()) as { items: AnimeLite[] };
          setItems(payload.items);
          setIdsKey(key);
          return;
        } catch {
          /* fall through to local */
        }
      }
      // offline / failed — the local entries already carry title + artwork
      setItems(listRef.current.map((e) => minimalLite(e.malId, e.title, e.image)));
      setIdsKey(key);
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, key]);

  const effective = ready ? (malIds.length ? (idsKey === key ? items : null) : []) : null;

  return (
    <div className="pb-24 lg:max-w-[1100px] lg:mx-auto">
      <h1 className="font-slab text-[26px] font-extrabold px-4 pt-4 pb-3">My List</h1>

      {!ready || (effective === null && malIds.length) ? (
        <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-6 gap-1.5 md:gap-2.5 px-4">
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
        <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-6 gap-1.5 md:gap-2.5 px-4">
          {effective.map((a) => (
            <div key={a.malId}>
              <PosterCard image={a.image} title={a.title} onClick={() => onSelect(a)} className="w-full aspect-[2/3]" />
              <p className="mt-1 text-[11px] text-gray-400 truncate">{a.title}</p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
