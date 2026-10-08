"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDownRight, ArrowUpRight, Bell, BellRing, Newspaper, X } from "lucide-react";
import type { AnimeLite } from "@/lib/types";
import { Switch } from "@/components/ui/switch";
import {
  fetchTop10Events,
  markTop10Read,
  minimalLite,
  timeAgo,
  useTop10ReadId,
  type Top10EventItem,
} from "@/lib/client-store";
import {
  disablePush,
  enablePush,
  pushEnabledFlag,
  pushPermission,
  pushSupported,
  pushSelfHeal,
} from "@/lib/push-client";
import { artUrl } from "@/lib/art";
import type { AnnNewsFeedItem } from "@/lib/ann-news";

/**
 * Netflix-style Top 10 notifications: a floating bell on Home (unread badge)
 * that opens a panel listing every "entered / left / climbed / fell" event —
 * now across the full Top 50 the See More screen shows (Top 10 changes stay
 * the headline copy). The feed is server-side (same for all viewers); the
 * read watermark is per-device (localStorage). Tapping a notification opens
 * that anime.
 *
 * The panel also carries the Web Push opt-in: one toggle that asks for OS
 * permission, subscribes this browser, and from then on lets the app ping
 * the lock screen even while it is closed (new episode / new anime / Top 10
 * / airing-soon reminders).
 */
export default function Top10Bell({ onSelect }: { onSelect: (a: AnimeLite) => void }) {
  const [events, setEvents] = useState<Top10EventItem[]>([]);
  const readId = useTop10ReadId();
  const [open, setOpen] = useState(false);
  const eventsRef = useRef<Top10EventItem[]>([]);
  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  // ---- ANN news (in-app surface of the tracked-anime news sweep) ----
  const [news, setNews] = useState<AnnNewsFeedItem[]>([]);
  const [newsReadAt, setNewsReadAt] = useState(0);
  const newsRef = useRef<AnnNewsFeedItem[]>([]);
  useEffect(() => {
    newsRef.current = news;
  }, [news]);
  useEffect(() => {
    try {
      setNewsReadAt(Number(localStorage.getItem("animetest123.newsreadat") ?? "0") || 0);
    } catch {
      /* storage blocked — news just never shows as unread */
    }
  }, []);

  // ---- push opt-in state ----
  const supported = useRef(false);
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushNote, setPushNote] = useState<string | null>(null);
  useEffect(() => {
    supported.current = pushSupported();
    setPushOn(pushEnabledFlag() && pushPermission() === "granted");
    // deploy self-heal: re-upsert the stored subscription while enabled
    pushSelfHeal();
  }, []);

  const togglePush = useCallback(async (on: boolean) => {
    setPushBusy(true);
    setPushNote(null);
    try {
      if (!on) {
        await disablePush();
        setPushOn(false);
        return;
      }
      const r = await enablePush();
      if (r.ok) {
        setPushOn(true);
        // instant proof the pipe is alive (also trains iOS that the PWA can notify)
        try {
          const reg = await navigator.serviceWorker.getRegistration("/");
          await reg?.showNotification("🔔 Clyle notifications on", {
            body: "You'll get a ping the moment a new anime or episode drops.",
            icon: "/icon-192.png",
            tag: "clyle-welcome",
          });
        } catch {
          /* permission was granted but the local show failed — the toggle is still on */
        }
      } else {
        setPushOn(false);
        setPushNote(
          r.reason === "denied"
            ? "Blocked in browser settings — allow notifications for this site, then flip this on again."
            : r.reason === "unsupported"
              ? "This browser can't do push notifications (on iPhone, install the app first: Share → Add to Home Screen)."
              : "Couldn't turn notifications on — try again in a moment.",
        );
      }
    } finally {
      setPushBusy(false);
    }
  }, []);

  const refresh = useCallback(() => {
    fetchTop10Events()
      .then(setEvents)
      .catch(() => undefined);
    // same cadence as the rank events — the route carries its own sweep
    // throttle, so this is a cheap read + feed payload
    fetch("/api/ann-news", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j && Array.isArray(j.feed)) setNews(j.feed as AnnNewsFeedItem[]);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    // On open the home rail's ?fresh=1 kick forces a server-side chart pass
    // (after()); new rank events land a few seconds later, so one +5s
    // follow-up keeps the unread badge honest without extra polling.
    let followUp: ReturnType<typeof setTimeout> | null = null;
    const scheduleFollowUp = () => {
      if (followUp) clearTimeout(followUp);
      followUp = setTimeout(() => {
        followUp = null;
        refresh();
      }, 5_000);
    };
    refresh();
    scheduleFollowUp();
    const onVis = () => {
      if (document.visibilityState === "visible") {
        refresh();
        scheduleFollowUp();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    const t = setInterval(refresh, 60_000);
    return () => {
      if (followUp) clearTimeout(followUp);
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(t);
    };
  }, [refresh]);

  const unread = events.filter((e) => e.id > readId).length;
  const unreadNews = news.filter((n) => Date.parse(n.at) > newsReadAt).length;
  const totalUnread = unread + unreadNews;

  const markNewsRead = useCallback(() => {
    const maxAt = newsRef.current.reduce((m, n) => Math.max(m, Date.parse(n.at) || 0), 0);
    if (maxAt > 0) {
      setNewsReadAt(maxAt);
      try {
        localStorage.setItem("animetest123.newsreadat", String(maxAt));
      } catch {
        /* storage blocked */
      }
    }
  }, []);

  const closePanel = useCallback(() => {
    setOpen(false);
    // highlights stay visible while the panel is open; closing marks seen
    const maxId = eventsRef.current.reduce((m, e) => Math.max(m, e.id), 0);
    if (maxId > 0) markTop10Read(maxId);
    markNewsRead();
  }, [markNewsRead]);

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
            aria-label={`Notifications${totalUnread ? ` (${totalUnread} unread)` : ""}`}
            className="pointer-events-auto relative w-10 h-10 rounded-full bg-black/45 backdrop-blur-sm border border-white/15 flex items-center justify-center active:scale-95 transition shadow-lg"
          >
            <Bell className="w-[18px] h-[18px] text-white" />
            {totalUnread > 0 ? (
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center border-2 border-black">
                {totalUnread > 9 ? "9+" : totalUnread}
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
                className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-[560px] md:max-w-[720px] lg:max-w-[920px] max-h-[85dvh] overflow-y-auto overscroll-contain rounded-b-2xl border-x border-b border-[#222] bg-[#0b0b0b] shadow-2xl"
                style={{ paddingTop: "env(safe-area-inset-top)" }}
              >
                <div className="sticky top-0 bg-[#0b0b0b]/95 backdrop-blur-sm px-4 pt-4 pb-3 border-b border-[#1c1c1c]">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="font-slab text-[18px] font-bold text-white leading-tight">Top 10 Notifications</h2>
                      <p className="text-[12px] text-gray-500 mt-0.5">When an anime climbs, falls, or enters the Top 50 This Month</p>
                    </div>
                    <button
                      onClick={closePanel}
                      aria-label="Close notifications"
                      className="shrink-0 w-8 h-8 rounded-full bg-[#1a1a1a] border border-[#2a2a2a] flex items-center justify-center active:scale-95 transition"
                    >
                      <X className="w-4 h-4 text-gray-300" />
                    </button>
                  </div>

                  {supported.current ? (
                    <div className="mt-3 rounded-xl border border-[#1f1f1f] bg-[#101010] px-3 py-2.5 flex items-center gap-3">
                      <BellRing className={`w-4.5 h-4.5 shrink-0 ${pushOn ? "text-red-500" : "text-gray-500"}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-semibold text-white leading-tight">Push notifications</p>
                        <p className="text-[11px] text-gray-500 leading-snug mt-0.5">
                          {pushOn ? "On — new episodes & anime pop up even with the app closed" : "Get pinged when a new anime or episode drops — even outside the app"}
                        </p>
                      </div>
                      <Switch
                        checked={pushOn}
                        disabled={pushBusy}
                        onCheckedChange={(v) => void togglePush(v)}
                        aria-label="Toggle push notifications"
                      />
                    </div>
                  ) : null}
                  {pushNote ? <p className="mt-2 text-[11px] text-amber-400/90 leading-snug">{pushNote}</p> : null}
                </div>

                {/* ANN News — new articles about the anime the fleet tracks */}
                {news.length > 0 ? (
                  <div className="border-b border-[#1c1c1c]">
                    <div className="px-4 pt-3 pb-1.5 flex items-center gap-2">
                      <Newspaper className="w-4 h-4 text-gray-400" />
                      <p className="text-[12px] font-bold uppercase tracking-wide text-gray-400">ANN News</p>
                    </div>
                    <ul className="divide-y divide-[#161616]">
                      {news.slice(0, 8).map((n) => {
                        const isUnread = Date.parse(n.at) > newsReadAt;
                        return (
                          <li key={`${n.guid}:${n.malId}`}>
                            <a
                              href={n.link}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={() => {
                                closePanel();
                              }}
                              className={`w-full text-left flex items-center gap-3 px-4 py-3 hover:bg-white/[0.04] active:bg-[#141414] transition ${
                                isUnread ? "bg-[#101010]" : ""
                              }`}
                            >
                              <div className="w-10 h-[40px] rounded-[4px] bg-[#161616] border border-[#262626] shrink-0 flex items-center justify-center">
                                <Newspaper className="w-4.5 h-4.5 text-gray-500" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-[13px] font-semibold text-white leading-snug" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                                  {n.headline}
                                </p>
                                <p className="text-[11px] text-gray-500 mt-0.5 truncate">
                                  ANN News — {n.anime} · {timeAgo(n.at)}
                                </p>
                              </div>
                              {isUnread ? <span className="w-2 h-2 rounded-full bg-red-600 shrink-0" /> : null}
                            </a>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}

                {events.length === 0 ? (
                  <div className="px-6 py-14 text-center">
                    <div className="mx-auto w-14 h-14 rounded-full bg-[#161616] border border-[#262626] flex items-center justify-center">
                      <Bell className="w-6 h-6 text-gray-600" />
                    </div>
                    <p className="mt-4 text-[14px] text-gray-300 font-semibold">No notifications yet</p>
                    <p className="mt-1.5 text-[12px] text-gray-500 leading-relaxed">
                      When an anime surpasses another, drops a rank, or enters the Top 10 This Month, it shows up here.
                    </p>
                  </div>
                ) : (
                  <ul className="divide-y divide-[#161616] pb-[max(12px,env(safe-area-inset-bottom))]">
                    {events.map((e) => {
                      const isUnread = e.id > readId;
                      const up = e.type === "up";
                      const down = e.type === "down";
                      const enter = e.type === "enter";
                      return (
                        <li key={e.id}>
                          <button
                            onClick={() => openEvent(e)}
                            className={`w-full text-left flex items-center gap-3 px-4 py-3 hover:bg-white/[0.04] active:bg-[#141414] transition ${
                              isUnread ? "bg-[#101010]" : ""
                            }`}
                          >
                            {e.image ? (
                              <img
                                src={artUrl(e.image)}
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
                                {enter || up ? (
                                  <ArrowUpRight className="w-3.5 h-3.5 text-red-500 shrink-0" />
                                ) : (
                                  <ArrowDownRight className={`w-3.5 h-3.5 shrink-0 ${down ? "text-gray-400" : "text-gray-500"}`} />
                                )}
                                {up ? (
                                  <span>
                                    surpassed {typeof e.prevRank === "number" ? <>#{e.prevRank}</> : "a rival"} — now <span className="text-white font-semibold">#{e.rank}</span>
                                  </span>
                                ) : down ? (
                                  <span>
                                    fell to <span className="text-white font-semibold">#{e.rank}</span>
                                    {typeof e.prevRank === "number" ? <> from #{e.prevRank}</> : null}
                                  </span>
                                ) : enter ? (
                                  <span>
                                    entered the {e.rank != null && e.rank > 10 ? "Top 50" : "Top 10"}
                                    {e.rank && e.rank > 0 ? <> at <span className="text-white font-semibold">#{e.rank}</span></> : null}
                                  </span>
                                ) : (
                                  <span>
                                    left the {typeof e.prevRank === "number" && e.prevRank > 10 ? "Top 50" : "Top 10"}
                                    {typeof e.prevRank === "number" ? <> (was #{e.prevRank})</> : null}
                                  </span>
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
