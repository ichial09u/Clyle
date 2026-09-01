"use client";

export default function PosterCard({
  image,
  title,
  logo,
  onClick,
  badge,
  className = "",
}: {
  image: string | null;
  title: string;
  /** Official title-logo art (transparent clearlogo) — rendered inside the poster. */
  logo?: string | null;
  onClick: () => void;
  badge?: string;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative shrink-0 overflow-hidden rounded-[6px] bg-[#161616] text-left active:scale-[0.97] hover:opacity-90 transition ${className}`}
      aria-label={title}
      title={title}
    >
      {image ? (
        <img src={image} alt={title} loading="lazy" className="w-full h-full object-cover" draggable={false} />
      ) : (
        <div className="w-full h-full flex items-end p-2">
          <span className="font-slab text-[12px] leading-tight text-gray-300 line-clamp-3">{title}</span>
        </div>
      )}
      {/* official title logo composited into the poster (Netflix-style card) */}
      {image && logo ? (
        <img
          src={logo}
          alt=""
          loading="lazy"
          draggable={false}
          className="pointer-events-none absolute left-1/2 bottom-[7%] w-[82%] -translate-x-1/2 object-contain max-h-[30%] drop-shadow-[0_2px_5px_rgba(0,0,0,0.95)]"
        />
      ) : null}
      {badge ? (
        <span className="absolute top-1 left-1 bg-[#d32f2f] text-white text-[9px] font-bold px-1.5 py-[2px] rounded">
          {badge}
        </span>
      ) : null}
    </button>
  );
}
