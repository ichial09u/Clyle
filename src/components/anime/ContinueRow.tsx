"use client";

import { useEffect, useState } from "react";
import { Play, X } from "lucide-react";
import type { ContinueItem } from "@/lib/types";
import { getEpThumb } from "@/lib/client-store";

/**
 * "Continue Watching" — VERTICAL stack (user: "make it be vertical and not
 * horizontal, showing only the card, nothing else"). One full-width card per
 * anime, everything lives ON the card (art, title, EP · percent, lang,
 * resume position); tapping the card resumes that episode at that exact
 * second — just how Continue Watching works. Red bar = exact progress
 * through the current episode. Card art is the episode's own captured scene
 * once that episode has been played; the poster is the fallback.
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
      <div className="flex flex-col gap-3 px-4">
        {items.map((item) => {
          const thumb = thumbs[item.malId] ?? null;
          return (
            <div key={item.malId} className="relative w-full">
              <button onClick={() => onResume(item)} className="block w-full text-left active:scale-[0.98] transition">
                <div className="relative w-full aspect-video md:aspect-[21/9] rounded-[8px] overflow-hidden bg-[#161616]">
                  {thumb ? (
                    <img src={thumb} alt={item.title} loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
                  ) : item.image ? (
                    <img src={item.image} alt={item.title} loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
                  ) : (
                    <div className="absolute inset-0 bg-gradient-to-br from-[#222] to-[#111]" />
                  )}
                  {/* dark gradient so the text/bar reads over the artwork */}
                  <div className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/90 via-black/55 to-transparent" />

                  {/* play badge */}
                  <span className="absolute inset-0 flex items-center justify-center">
                    <span className="w-11 h-11 rounded-full bg-black/55 backdrop-blur flex items-center justify-center">
                      <Play className="w-5 h-5 text-white ml-0.5" />
                    </span>
                  </span>

                  {/* everything on the card: title, episode + percent */}
                  <span className="absolute left-3 right-16 bottom-6 text-[12.5px] font-bold text-white drop-shadow truncate">
                    {item.title}
                  </span>
                  <span className="absolute left-3 bottom-2.5 text-[11px] font-bold text-gray-200 drop-shadow">
                    EP {item.episode} · {item.percent}%
                  </span>
                  <span className="absolute right-3 bottom-2.5 text-[9.5px] text-gray-300 uppercase tracking-wide">
                    {item.lang}
                  </span>

                  {/* the red progress bar — shows where you were last */}
                  <span className="absolute left-3 right-3 bottom-[6px] h-[3px] rounded-full bg-white/25 overflow-hidden">
                    <span className="block h-full bg-[#d32f2f] rounded-full" style={{ width: `${Math.max(3, item.percent)}%` }} />
                  </span>
                </div>
              </button>

              {/* remove from Continue Watching */}
              <button
                onClick={() => onRemove(item.malId)}
                className="absolute top-1.5 right-1.5 w-7 h-7 rounded-full bg-black/65 backdrop-blur flex items-center justify-center text-gray-300 hover:text-white hover:bg-[#d32f2f] active:scale-95 transition"
                aria-label={`Remove ${item.title} from Continue Watching`}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
