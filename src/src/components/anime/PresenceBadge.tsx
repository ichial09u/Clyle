"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Monitor, Smartphone, Globe, X } from "lucide-react";
import {
  ensurePresenceHeartbeat,
  subscribePresence,
  getPresenceSnapshot,
  type PresenceData,
} from "@/lib/presence-client";

/**
 * The LIVE counter — top-left of the homepage, over the hero.
 *
 * "🟢 37 online" — every viewer across the site + Android app + PWA, in
 * all regions, counted by the server's sliding 3-minute presence window.
 * Tapping the pill opens the breakdown panel: platforms (Android / iOS /
 * Web) and the regions people are watching from (country flags).
 *
 * Data comes from the app-wide heartbeat (presence-client.ts, mounted in
 * the root layout) via a useSyncExternalStore subscription — this component
 * renders only what the latest heartbeat response reported and stays
 * hidden entirely until the first aggregate lands (offline → no badge).
 */

/** ISO-3166 alpha-2 -> regional-indicator flag emoji ("??" -> globe). */
function flagOf(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return "🌍";
  return code.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

const PLATFORM_ICONS: Record<string, typeof Monitor> = {
  Android: Smartphone,
  iOS: Smartphone,
  Web: Monitor,
};

export default function PresenceBadge() {
  // the heartbeat lifecycle is app-wide and idempotent; touching it here
  // is a safety net for direct mounts that skip the layout component
  useEffect(() => {
    ensurePresenceHeartbeat();
  }, []);

  const data = usePresence();
  const [open, setOpen] = useState(false);
  // the panel is a body-level portal, so it must find the badge's real
  // position itself — the content column starts after the desktop nav rail,
  // and a hard-coded left would overlap the rail (measured > guessed)
  const badgeRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 12, top: 58 });
  const toggle = useCallback(() => {
    if (!open && badgeRef.current) {
      const r = badgeRef.current.getBoundingClientRect();
      setPos({ left: Math.max(12, Math.round(r.left)), top: Math.round(r.bottom) + 8 });
    }
    setOpen(!open);
  }, [open]);
  const close = useCallback(() => setOpen(false), []);

  if (!data || data.online <= 0) return null;

  return (
    <>
      {/* sticky zero-height wrapper — mirrors Top10Bell, but pinned top-LEFT */}
      <div className="sticky top-0 z-30 h-0 pointer-events-none">
        <div className="flex justify-start pt-3 pl-3">
          <button
            ref={badgeRef}
            onClick={toggle}
            aria-label={`${data.online} online now — show live viewer breakdown`}
            aria-expanded={open}
            className="pointer-events-auto h-10 rounded-full pl-3 pr-3.5 bg-black/45 backdrop-blur-sm border border-white/15 flex items-center gap-2 active:scale-95 transition shadow-lg"
          >
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
            </span>
            <span className="text-[13px] font-bold leading-none tabular-nums text-white">{data.online}</span>
            <span className="text-[12px] leading-none text-gray-300">online</span>
          </button>
        </div>
      </div>

      {open
        ? createPortal(
            <div className="fixed inset-0 z-[58]" role="dialog" aria-label="Live viewers">
              <div className="absolute inset-0" onClick={close} />
              <div
                className="absolute w-[248px] rounded-2xl border border-[#222] bg-[#0b0b0b]/95 backdrop-blur-md shadow-2xl overflow-hidden"
                style={{ top: pos.top, left: pos.left }}
              >
                <div className="flex items-start justify-between gap-2 px-4 pt-3.5 pb-3">
                  <div>
                    <p className="font-slab text-[15px] font-bold text-white leading-tight">
                      {data.online} watching now
                    </p>
                    <p className="text-[11px] text-gray-500 mt-0.5">Live across all regions &amp; platforms</p>
                  </div>
                  <button
                    onClick={close}
                    aria-label="Close live viewers panel"
                    className="shrink-0 w-7 h-7 rounded-full bg-[#1a1a1a] border border-[#2a2a2a] flex items-center justify-center active:scale-95 transition"
                  >
                    <X className="w-3.5 h-3.5 text-gray-300" />
                  </button>
                </div>

                {data.platforms.length ? (
                  <div className="px-4 pb-3 border-t border-[#1c1c1c] pt-3">
                    <p className="text-[10.5px] font-bold uppercase tracking-wider text-gray-500 mb-2">Platforms</p>
                    <div className="flex flex-col gap-1.5">
                      {data.platforms.slice(0, 4).map((p) => {
                        const Icon = PLATFORM_ICONS[p.name] ?? Globe;
                        const pct = Math.max(4, Math.round((p.count / data.online) * 100));
                        return (
                          <div key={p.name} className="flex items-center gap-2">
                            <Icon className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                            <span className="text-[12.5px] text-gray-200 w-16 shrink-0">{p.name}</span>
                            <span className="flex-1 h-1.5 rounded-full bg-[#1d1d1d] overflow-hidden">
                              <span className="block h-full rounded-full bg-emerald-500/80" style={{ width: `${pct}%` }} />
                            </span>
                            <span className="text-[11.5px] font-bold text-gray-300 tabular-nums w-5 text-right">{p.count}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null}

                {data.regions.length ? (
                  <div className="px-4 pb-4 pt-3 border-t border-[#1c1c1c]">
                    <p className="text-[10.5px] font-bold uppercase tracking-wider text-gray-500 mb-2">Regions</p>
                    <div className="flex flex-wrap gap-1.5">
                      {data.regions.map((r) => (
                        <span
                          key={r.code}
                          className="h-7 rounded-full px-2.5 flex items-center gap-1.5 bg-[#1d1d1d] ring-1 ring-inset ring-white/10"
                        >
                          <span className="text-[13px] leading-none">{flagOf(r.code)}</span>
                          <span className="text-[11.5px] font-bold text-gray-200 tabular-nums leading-none">{r.count}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
/* store subscription as a hook so the JSX stays tidy */
function usePresence(): PresenceData | null {
  return useSyncExternalStore(subscribePresence, getPresenceSnapshot, () => null);
}
