"use client";

import { useAiringNow, NEW_EPISODE_SOON_MS } from "@/lib/airing-tick";

export default function PosterCard({
  image,
  title,
  onClick,
  badge,
  nextEpisodeAt,
  className = "",
}: {
  image: string | null;
  title: string;
  onClick: () => void;
  badge?: string;
  /** unix SECONDS the next episode airs — shows "New episode soon" within 3 days of it */
  nextEpisodeAt?: number | null;
  className?: string;
}) {
  // ticking clock only matters when this card actually has an air time
  const now = useAiringNow();
  const msUntil = nextEpisodeAt ? nextEpisodeAt * 1000 - now : Infinity;
  // strictly FUTURE (already-aired times hide — the badge would be a lie);
  // the 3-day window is the user-facing "new episode soon" rule
  const soon = msUntil > 0 && msUntil <= NEW_EPISODE_SOON_MS;

  return (
    <button
      onClick={onClick}
      className={`group relative shrink-0 overflow-hidden rounded-[6px] bg-[#161616] text-left ring-1 ring-inset ring-white/[0.06] transition-all duration-200 ease-out hover:-translate-y-0.5 hover:ring-1 hover:ring-inset hover:ring-white/30 hover:shadow-[0_10px_22px_rgba(0,0,0,0.55)] active:scale-[0.97] hover:opacity-100 ${className}`}
      aria-label={title}
      title={title}
    >
      {image ? (
        <img src={image} alt={title} loading="lazy" className="w-full h-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.04]" draggable={false} />
      ) : (
        <div className="w-full h-full flex items-end p-2">
          <span className="font-slab text-[12px] leading-tight text-gray-300 line-clamp-3">{title}</span>
        </div>
      )}
      {badge ? (
        <span className="absolute top-1 left-1 bg-[#d32f2f] text-white text-[9px] font-bold px-1.5 py-[2px] rounded">
          {badge}
        </span>
      ) : null}
      {soon ? (
        <span className="absolute bottom-0 inset-x-0 flex items-center justify-center gap-1 bg-black/75 px-1 py-[3px]">
          <span className="w-1 h-1 rounded-full bg-emerald-400 shrink-0" />
          <span className="text-[8.5px] font-semibold leading-none text-white tracking-wide truncate">New episode soon</span>
        </span>
      ) : null}
    </button>
  );
}
