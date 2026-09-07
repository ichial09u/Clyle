"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { ContinueItem } from "@/lib/types";
import { getEpThumb } from "@/lib/client-store";

/**
 * "Continue Watching" — Netflix-style horizontal poster strip (user's
 * screenshot order). Pure cover cards, bigger than the homepage row
 * (150×212 → 192×271 vs homepage 126×178): episode scene thumbnail once
 * the episode has been played, poster as fallback. No text overlays —
 * the ONLY things on the card are the artwork, a bottom flush red
 * progress bar (exact percent through the episode) and the small ✕.
 * Tapping the card resumes that episode at the saved second.
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
      <div className="flex gap-2.5 px-4 overflow-x-auto no-scrollbar scroll-smooth snap-x snap-proximity">
        {items.map((item) => {
          const thumb = thumbs[item.malId] ?? null;
          return (
            <div key={item.malId} className="relative shrink-0 snap-start">
              <button
                onClick={() => onResume(item)}
                className="relative block w-[150px] h-[212px] md:w-[172px] md:h-[243px] lg:w-[192px] lg:h-[271px] rounded-[10px] overflow-hidden bg-[#161616] active:scale-[0.97] transition"
                aria-label={`Resume ${item.title} episode ${item.episode}`}
              >
                {thumb ? (
                  <img src={thumb} alt={item.title} loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
                ) : item.image ? (
                  <img src={item.image} alt={item.title} loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
                ) : (
                  <div className="absolute inset-0 bg-gradient-to-br from-[#222] to-[#111]" />
                )}

                {/* bottom flush red progress bar — where you were last */}
                <span className="absolute inset-x-0 bottom-0 h-[4px] bg-white/20">
                  <span className="block h-full bg-[#d32f2f]" style={{ width: `${Math.max(3, item.percent)}%` }} />
                </span>
              </button>

              {/* remove from Continue Watching */}
              <button
                onClick={() => onRemove(item.malId)}
                className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-black/65 backdrop-blur flex items-center justify-center text-gray-300 hover:text-white hover:bg-[#d32f2f] active:scale-95 transition"
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
