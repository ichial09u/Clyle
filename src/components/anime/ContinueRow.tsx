"use client";

import { Info, X } from "lucide-react";
import type { ContinueItem } from "@/lib/types";

/**
 * "Continue Watching" — Crunchyroll-app-style portrait cards (user's
 * screenshot format): full-bleed poster art, (i) info button top-left,
 * ✕ remove button top-right, bold "Episode N" at the bottom with a
 * heavy drop shadow, and a bottom-flush red progress bar (exact
 * percent through the episode). Tapping the card resumes that
 * episode at the saved second; tapping (i) opens the show's details.
 */
export default function ContinueRow({
  items,
  onResume,
  onRemove,
  onInfo,
}: {
  items: ContinueItem[];
  onResume: (item: ContinueItem) => void;
  onRemove: (malId: number) => void;
  onInfo?: (item: ContinueItem) => void;
}) {
  if (!items.length) return null;
  return (
    <section className="mt-5">
      <h2 className="font-slab text-[21px] font-bold px-4 mb-3">Continue Watching</h2>
      <div className="flex gap-2.5 px-4 overflow-x-auto no-scrollbar scroll-smooth snap-x snap-proximity">
        {items.map((item) => {
          return (
            <div key={item.malId} className="relative shrink-0 snap-start">
              <button
                onClick={() => onResume(item)}
                className="group relative block w-[150px] h-[212px] md:w-[172px] md:h-[243px] lg:w-[192px] lg:h-[271px] rounded-[12px] overflow-hidden bg-[#161616] active:scale-[0.97] transition"
                aria-label={`Resume ${item.title} episode ${item.episode}`}
              >
                {item.image ? (
                  <img src={item.image} alt={item.title} loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
                ) : (
                  <div className="absolute inset-0 bg-gradient-to-br from-[#222] to-[#111]" />
                )}

                {/* bottom gradient so the episode label reads on any artwork */}
                <span className="absolute inset-x-0 bottom-0 h-[64px] bg-gradient-to-t from-black/85 via-black/35 to-transparent pointer-events-none" />

                {/* Episode N — bold, shadowed, just above the progress bar */}
                <span
                  className="absolute left-2.5 right-2 bottom-[11px] text-left text-white font-bold text-[16px] md:text-[17px] leading-tight truncate [text-shadow:0_2px_4px_rgb(0_0_0/0.9),0_0_2px_rgb(0_0_0/0.8)]"
                >
                  Episode {item.episode}
                </span>

                {/* bottom flush red progress bar — where you were last */}
                <span className="absolute inset-x-0 bottom-0 h-[5px] bg-white/25">
                  <span className="block h-full bg-[#e03a3a]" style={{ width: `${Math.max(3, item.percent)}%` }} />
                </span>
              </button>

              {/* (i) info — opens the show's details page */}
              {onInfo ? (
                <button
                  onClick={() => onInfo(item)}
                  className="absolute top-1.5 left-1.5 w-7 h-7 rounded-full bg-black/55 ring-1 ring-white/25 backdrop-blur-sm flex items-center justify-center text-white hover:bg-black/80 active:scale-95 transition"
                  aria-label={`View details for ${item.title}`}
                >
                  <Info className="w-[15px] h-[15px]" strokeWidth={2.4} />
                </button>
              ) : null}

              {/* remove from Continue Watching */}
              <button
                onClick={() => onRemove(item.malId)}
                className="absolute top-1.5 right-1.5 w-7 h-7 rounded-full bg-black/55 ring-1 ring-white/25 backdrop-blur-sm flex items-center justify-center text-white hover:bg-[#d32f2f] active:scale-95 transition"
                aria-label={`Remove ${item.title} from Continue Watching`}
              >
                <X className="w-[15px] h-[15px]" strokeWidth={2.4} />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
