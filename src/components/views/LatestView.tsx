"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { AnimeLite, LatestUpdate } from "@/lib/types";
import { timeAgo } from "@/lib/client-store";

export default function LatestView({ onSelect }: { onSelect: (a: AnimeLite) => void }) {
  const [data, setData] = useState<{ updates: LatestUpdate[]; lastSync: string | null; syncing: boolean } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/latest");
      setData(await res.json());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function syncNow() {
    setSyncing(true);
    setResult(null);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const payload = (await res.json()) as { episodesAdded: number; animeAdded: number; ok: boolean };
      setResult(
        payload.ok
          ? `Imported ${payload.episodesAdded} new episodes • ${payload.animeAdded} new anime`
          : "Sync failed — MAL may be busy, try again shortly.",
      );
      await load();
    } catch {
      setResult("Sync failed — network error.");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="pb-24">
      <div className="flex items-center justify-between px-4 pt-4 pb-1">
        <h1 className="font-slab text-[26px] font-extrabold">Latest</h1>
        <button
          onClick={syncNow}
          disabled={syncing}
          className="flex items-center gap-2 bg-white text-black text-[13px] font-bold rounded-full px-4 py-2 hover:bg-gray-200 active:scale-95 transition disabled:opacity-60"
        >
          <RefreshCw className={`w-4 h-4 ${syncing ? "animate-spin" : ""}`} />
          {syncing ? "Syncing…" : "Sync now"}
        </button>
      </div>
      <p className="px-4 text-[11.5px] text-gray-500">
        {data?.lastSync ? `Last import ${timeAgo(data.lastSync)}` : "Never synced"} — the app also auto-imports on open.
      </p>
      {result ? <p className="px-4 mt-1 text-[12.5px] text-[#ff8a80]">{result}</p> : null}

      {!data ? (
        <div className="mt-4 space-y-3 px-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex gap-3">
              <div className="w-[74px] h-[104px] rounded-[6px] bg-[#161616] animate-pulse" />
              <div className="flex-1 pt-2 space-y-2">
                <div className="h-4 bg-[#161616] rounded animate-pulse w-2/3" />
                <div className="h-3 bg-[#161616] rounded animate-pulse w-1/3" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-[#161616]">
          {data.updates.map((u) => {
            const hasNew = u.latest > u.total;
            return (
              <li key={u.anime.malId}>
                <button onClick={() => onSelect(u.anime)} className="w-full flex gap-3 px-4 py-3 hover:bg-[#0f0f0f] active:bg-[#161616] transition text-left">
                  {u.anime.image ? (
                    <img src={u.anime.image} alt="" className="w-[74px] h-[104px] rounded-[6px] object-cover bg-[#161616]" loading="lazy" />
                  ) : (
                    <div className="w-[74px] h-[104px] rounded-[6px] bg-[#161616]" />
                  )}
                  <div className="flex-1 min-w-0 pt-1">
                    <div className="flex items-center gap-2">
                      <p className="font-slab font-bold text-[14.5px] truncate">{u.anime.title}</p>
                      {u.anime.airing ? (
                        <span className="shrink-0 text-[9px] font-bold bg-[#d32f2f] px-1.5 py-[2px] rounded">AIRING</span>
                      ) : null}
                    </div>
                    <p className="text-[12px] text-gray-400 mt-1">
                      Episode {u.latest} available
                      {hasNew ? <span className="text-[#ff8a80] font-bold"> • NEW</span> : null}
                    </p>
                    <p className="text-[11px] text-gray-600 mt-0.5">imported {timeAgo(u.updatedAt)}</p>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
