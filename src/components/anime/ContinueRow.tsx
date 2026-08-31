"use client";

import { useEffect, useState } from "react";
import { Play, X } from "lucide-react";
import type { ContinueItem } from "@/lib/types";
import { getEpThumb } from "@/lib/client-store";

/**
 * "Continue Watching" rail — one card per anime, red bar = exact progress
 * through the current episode; tapping resumes that episode at that second.
 * Card art is the episode's own captured scene (like Crunchyroll's preview
 * thumbnails) once that episode has been played; the poster is the fallback.
 */
export default function ContinueRow({
  items,
  onResume,
  onRemove,
}: {
  items: ContinueItem[];
  onResume: (item: ContinueItem) => void;
  onRemove: (malId: number) => void;
}) {
  // resolve the per-episode scene thumbnails from the local store
  const [thumbs, setThumbs] = useState<Record<number, string | null>>({});

  useEffect(() => {
    const resolve = () => {
      const next: Record<number, string | null> = {};
      for (const it of items) next[it.malId] = getEpThumb(it.malId, it.episode, it.lang);
      setThumbs(next);
    };
    resolve();
    window.addEventListener("epthumbs-changed", resolve);
    window.addEventListener("progress-changed", resolve);
    return () => {
      window.removeEventListener("epthumbs-changed", resolve);
      window.removeEventListener("progress-changed", resolve);
    };
  }, [items]);

  if (!items.length) return null;
  return (
    <section className="mt-5">
      <h2 className="font-slab text-[21px] font-bold px-4 mb-3">Continue Watching</h2>
      <div className="flex gap-3 overflow-x-auto no-scrollbar px-4 pb-1">
        {items.map((item) => {
          const thumb = thumbs[item.malId] ?? null;
          return (
            <div key={item.malId} className="relative shrink-0 w-[196px]">
              <button onClick={() => onResume(item)} className="block w-full text-left active:scale-[0.97] transition">
                <div className="relative w-[196px] h-[110px] rounded-[8px] overflow-hidden bg-[#161616]">
                  {thumb ? (
                    <img src={thumb} alt={item.title} loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
                  ) : item.image ? (
                    <img src={item.image} alt={item.title} loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
                  ) : (
                    <div className="absolute inset-0 bg-gradient-to-br from-[#222] to-[#111]" />
                  )}
                  {/* dark gradient so the text/bar reads over the artwork */}
                  <div className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/85 to-transparent" />

                  {/* play badge */}
                  <span className="absolute inset-0 flex items-center justify-center">
                    <span className="w-10 h-10 rounded-full bg-black/55 backdrop-blur flex items-center justify-center">
                      <Play className="w-5 h-5 text-white ml-0.5" />
                    </span>
                  </span>

                  {/* episode + percent */}
                  <span className="absolute left-2 bottom-2 text-[11px] font-bold text-white drop-shadow">
                    EP {item.episode} · {item.percent}%
                  </span>
                  <span className="absolute right-2 bottom-2 text-[9.5px] text-gray-300 uppercase tracking-wide">
                    {item.lang}
                  </span>

                  {/* the red progress bar — exact position in this episode */}
                  <span className="absolute left-2 right-2 bottom-[5px] h-[3px] rounded-full bg-white/25 overflow-hidden">
                    <span className="block h-full bg-[#d32f2f] rounded-full" style={{ width: `${Math.max(3, item.percent)}%` }} />
                  </span>
                </div>
                <p className="mt-1.5 text-[11.5px] text-gray-300 truncate w-[196px]">{item.title}</p>
              </button>

              {/* remove from Continue Watching */}
              <button
                onClick={() => onRemove(item.malId)}
                className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/65 backdrop-blur flex items-center justify-center text-gray-300 hover:text-white hover:bg-[#d32f2f] active:scale-95 transition"
                aria-label={`Remove ${item.title} from Continue Watching`}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
