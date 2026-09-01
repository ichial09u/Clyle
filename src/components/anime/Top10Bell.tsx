"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDownRight, ArrowUpRight, Bell, X } from "lucide-react";
import type { AnimeLite } from "@/lib/types";
import {
  fetchTop10Events,
  markTop10Read,
  minimalLite,
  timeAgo,
  useTop10ReadId,
  type Top10EventItem,
} from "@/lib/client-store";

/**
 * Netflix-style Top 10 notifications: a floating bell on Home (unread badge)
 * that opens a panel listing every "entered / left the Top 10 Today" event.
 * The feed is server-side (same for all viewers); the read watermark is
 * per-device (localStorage). Tapping a notification opens that anime.
 */
export default function Top10Bell({ onSelect }: { onSelect: (a: AnimeLite) => void }) {
  const [events, setEvents] = useState<Top10EventItem[]>([]);
  const readId = useTop10ReadId();
  const [open, setOpen] = useState(false);
  const eventsRef = useRef<Top10EventItem[]>([]);
  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  const refresh = useCallback(() => {
    fetchTop10Events()
      .then(setEvents)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    const onVis = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    const t = setInterval(refresh, 60_000);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(t);
    };
  }, [refresh]);

  const unread = events.filter((e) => e.id > readId).length;

  const closePanel = useCallback(() => {
    setOpen(false);
    // highlights stay visible while the panel is open; closing marks seen
    const maxId = eventsRef.current.reduce((m, e) => Math.max(m, e.id), 0);
    if (maxId > 0) markTop10Read(maxId);
  }, []);

  const openEvent = (e: Top10EventItem) => {
    closePanel();
    onSelect(minimalLite(e.malId, e.title, e.image));
  };

  return (
    <>
      {/* sticky zero-height wrapper: the bell floats over the hero, top-right,
          and stays put while the page scrolls */}
      <div className="sticky top-0 z-30 h-0 pointer-events-none">
        <div className="flex justify-end pt-3 pr-3">
          <button
            onClick={() => setOpen(true)}
            aria-label={`Top 10 notifications${unread ? ` (${unread} unread)` : ""}`}
            className="pointer-events-auto relative w-10 h-10 rounded-full bg-black/45 backdrop-blur-sm border border-white/15 flex items-center justify-center active:scale-95 transition shadow-lg"
          >
            <Bell className="w-[18px] h-[18px] text-white" />
            {unread > 0 ? (
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center border-2 border-black">
                {unread > 9 ? "9+" : unread}
              </span>
            ) : null}
          </button>
        </div>
      </div>

      {open
        ? createPortal(
            <div className="fixed inset-0 z-[60]" role="dialog" aria-label="Top 10 notifications">
              <div className="absolute inset-0 bg-black/70" onClick={closePanel} />
              <div
                className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-[560px] max-h-[85dvh] overflow-y-auto overscroll-contain rounded-b-2xl border-x border-b border-[#222] bg-[#0b0b0b] shadow-2xl"
                style={{ paddingTop: "env(safe-area-inset-top)" }}
              >
                <div className="sticky top-0 bg-[#0b0b0b]/95 backdrop-blur-sm px-4 pt-4 pb-3 border-b border-[#1c1c1c] flex items-start justify-between gap-3">
                  <div>
                    <h2 className="font-slab text-[18px] font-bold text-white leading-tight">Top 10 Notifications</h2>
                    <p className="text-[12px] text-gray-500 mt-0.5">When an anime enters or leaves today&apos;s Top 10</p>
                  </div>
                  <button
                    onClick={closePanel}
                    aria-label="Close notifications"
                    className="shrink-0 w-8 h-8 rounded-full bg-[#1a1a1a] border border-[#2a2a2a] flex items-center justify-center active:scale-95 transition"
                  >
                    <X className="w-4 h-4 text-gray-300" />
                  </button>
                </div>

                {events.length === 0 ? (
                  <div className="px-6 py-14 text-center">
                    <div className="mx-auto w-14 h-14 rounded-full bg-[#161616] border border-[#262626] flex items-center justify-center">
                      <Bell className="w-6 h-6 text-gray-600" />
                    </div>
                    <p className="mt-4 text-[14px] text-gray-300 font-semibold">No notifications yet</p>
                    <p className="mt-1.5 text-[12px] text-gray-500 leading-relaxed">
                      When an anime enters or leaves the Top 10 Today, it shows up here. Watch something to get the list
                      started.
                    </p>
                  </div>
                ) : (
                  <ul className="divide-y divide-[#161616] pb-[max(12px,env(safe-area-inset-bottom))]">
                    {events.map((e) => {
                      const isUnread = e.id > readId;
                      const enter = e.type === "enter";
                      return (
                        <li key={e.id}>
                          <button
                            onClick={() => openEvent(e)}
                            className={`w-full text-left flex items-center gap-3 px-4 py-3 active:bg-[#141414] transition ${
                              isUnread ? "bg-[#101010]" : ""
                            }`}
                          >
                            {e.image ? (
                              <img
                                src={e.image}
                                alt=""
                                draggable={false}
                                className="w-10 h-[56px] object-cover rounded-[4px] bg-[#161616] shrink-0"
                              />
                            ) : (
                              <div className="w-10 h-[56px] rounded-[4px] bg-[#161616] shrink-0" />
                            )}
                            <div className="flex-1 min-w-0">
                              <p className="text-[13px] font-semibold text-white truncate">{e.title}</p>
                              <p className="text-[12px] text-gray-400 mt-0.5 flex items-center gap-1">
                                {enter ? (
                                  <ArrowUpRight className="w-3.5 h-3.5 text-red-500 shrink-0" />
                                ) : (
                                  <ArrowDownRight className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                                )}
                                {enter ? (
                                  <span>
                                    entered the Top 10{e.rank && e.rank > 0 ? <> at <span className="text-white font-semibold">#{e.rank}</span></> : null}
                                  </span>
                                ) : (
                                  <span>left the Top 10</span>
                                )}
                              </p>
                              <p className="text-[11px] text-gray-600 mt-0.5">{timeAgo(e.createdAt)}</p>
                            </div>
                            {isUnread ? <span className="w-2 h-2 rounded-full bg-red-600 shrink-0" /> : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
