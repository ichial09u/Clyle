"use client";

import { useCallback, useEffect, useRef, useState, Fragment } from "react";
import type { AnimeLite, ContinueItem, HomePayload } from "@/lib/types";
import HeroBanner from "@/components/anime/HeroBanner";
import Row from "@/components/anime/Row";
import PosterCard from "@/components/anime/PosterCard";
import ContinueRow from "@/components/anime/ContinueRow";
import Top10Bell from "@/components/anime/Top10Bell";
import ArrivingRail from "@/components/anime/ArrivingRail";
import {
  loadContinueItems, removeProgress, sweepRemovedProgress, timeAgo, useProgressVersion,
  fetchTop10Month, animeFromContinue, type Top10MonthEntry,
  fetchArriving, type ArrivingEntry,
} from "@/lib/client-store";
import { getUserId } from "@/lib/profile-store";

// ---- arrival episode import ----------------------------------------------
// "As soon as you get into the website or app the episodes import": one kick
// per arrival — cold open, navigating back home, or PWA coming back to the
// foreground. The server (POST /api/sync?kick=1) throttles real sweeps to one
// per 5 min and answers instantly otherwise, so extra kicks are near-free.
// Module-scope timestamp: survives view switches inside the SPA so a quick
// home → details → home round-trip doesn't re-kick.
const KICK_MIN_GAP_MS = 60_000;
let lastKickAt = 0;

function kickEpisodeImport() {
  if (Date.now() - lastKickAt < KICK_MIN_GAP_MS) return;
  lastKickAt = Date.now();
  fetch("/api/sync?kick=1", { method: "POST" }).catch(() => undefined);
}

export default function HomeView({
  onSelect,
  onDetails,
  onWatch,
  onResume,
  onTop50,
  onGenre,
}: {
  onSelect: (a: AnimeLite) => void;
  onDetails: (a: AnimeLite) => void;
  onWatch: (a: AnimeLite) => void;
  onResume: (item: ContinueItem) => void;
  onTop50: () => void;
  /** "See More" on a genre rail — opens the full genre grid */
  onGenre: (genre: string) => void;
}) {
  const [data, setData] = useState<HomePayload | null>(null);
  const [error, setError] = useState(false);
  const [continueItems, setContinueItems] = useState<ContinueItem[]>([]);
  const [suggestions, setSuggestions] = useState<AnimeLite[]>([]);
  const [suggestAnchor, setSuggestAnchor] = useState<string | null>(null);
  const [top10, setTop10] = useState<Top10MonthEntry[]>([]);
  const [arriving, setArriving] = useState<ArrivingEntry[]>([]);
  const progressVersion = useProgressVersion();
  const lastTop10Fetch = useRef(0);

  const refreshContinue = useCallback(() => {
    // heal any removal whose DELETE request was lost — re-fired BEFORE the
    // server list read; the local tombstone keeps the card hidden meanwhile
    sweepRemovedProgress();
    loadContinueItems().then(setContinueItems).catch(() => undefined);
  }, []);

  // "Suggested For You" — lives inside the Continue Watching area: what the
  // user is watching drives genre-based picks they haven't started yet.
  // Refetches alongside continue items (progress changes → new suggestions).
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/suggestions?userId=${encodeURIComponent(getUserId())}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { items?: AnimeLite[]; becauseOf?: string | null }) => {
        if (cancelled) return;
        setSuggestions(d.items ?? []);
        setSuggestAnchor(d.becauseOf ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [progressVersion, continueItems.length]);

  useEffect(() => {
    refreshContinue();
  }, [refreshContinue, progressVersion]);

  // Top 10 This Month — ranked by Anime Trending's live chart (server-side,
  // active: titles swap ranks as the community vote shifts; the bell carries
  // the changes). The rail is always populated once the first pass lands.
  //
  // "Updated every time you open the site/app": every open (cold mount or
  // PWA foreground return) sends ?fresh=1 — the server answers from its
  // snapshot instantly but schedules a FORCED live re-check via after(); the
  // +5s follow-up below pulls that fresh ranking into the rail right away
  // instead of waiting for the next 60s poll. The 60s poll itself stays
  // plain (server-side TTL-gated) so background tab time stays free.
  const refreshTop10 = useCallback((fresh = false) => {
    lastTop10Fetch.current = Date.now();
    fetchTop10Month(fresh).then(setTop10).catch(() => undefined);
  }, []);

  useEffect(() => {
    let followUp: ReturnType<typeof setTimeout> | null = null;
    const open = () => {
      refreshTop10(true);
      if (followUp) clearTimeout(followUp);
      followUp = setTimeout(() => {
        followUp = null;
        if (document.visibilityState === "visible") refreshTop10();
      }, 5_000);
    };
    open();
    const onVis = () => {
      if (document.visibilityState === "visible" && Date.now() - lastTop10Fetch.current > 15_000) open();
    };
    document.addEventListener("visibilitychange", onVis);
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") refreshTop10();
    }, 60_000);
    return () => {
      if (followUp) clearTimeout(followUp);
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(poll);
    };
  }, [refreshTop10]);

  // Arriving — the Netflix-style coming-soon rail. Same live discipline as
  // the Top 10 rail: fresh on every open / PWA foreground return, a +5s
  // follow-up, and a 60s poll; the server TTL-gates the real work.
  const refreshArriving = useCallback((fresh = false) => {
    fetchArriving(fresh).then(setArriving).catch(() => undefined);
  }, []);

  // Most Watched on Clyle — LIVE, REAL, GLOBAL. Every viewer's player
  // heartbeats land in the server's WatchStat table (site + app combined);
  // this rail fetches the all-time aggregate fresh on every open, on every
  // foreground return, and on a 60s poll — no home-cache staleness, no
  // per-device slice. Hidden entirely until people actually watch things.
  const [watched, setWatched] = useState<AnimeLite[]>([]);
  const refreshWatched = useCallback(() => {
    fetch("/api/watchtime?all=1&limit=12", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { items?: Array<AnimeLite & { seconds: number }> }) => {
        setWatched((d.items ?? []).filter((a) => a.seconds > 60));
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let followUp: ReturnType<typeof setTimeout> | null = null;
    const open = () => {
      refreshArriving(true);
      if (followUp) clearTimeout(followUp);
      followUp = setTimeout(() => {
        followUp = null;
        if (document.visibilityState === "visible") refreshArriving();
      }, 5_000);
    };
    open();
    const onVis = () => {
      if (document.visibilityState === "visible") refreshArriving(true);
    };
    document.addEventListener("visibilitychange", onVis);
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") refreshArriving();
    }, 60_000);
    return () => {
      if (followUp) clearTimeout(followUp);
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(poll);
    };
  }, [refreshArriving]);

  // Most Watched lifecycle: fresh on open + foreground return + 60s poll
  useEffect(() => {
    refreshWatched();
    const onVis = () => {
      if (document.visibilityState === "visible") refreshWatched();
    };
    document.addEventListener("visibilitychange", onVis);
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") refreshWatched();
    }, 60_000);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(poll);
    };
  }, [refreshWatched]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/home");
        if (!res.ok) throw new Error(String(res.status));
        const payload = (await res.json()) as HomePayload;
        if (!cancelled) setData(payload);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // arrival kick — starts the episode import the moment the app is open and
  // again every time the PWA returns to the foreground (a restored session
  // must catch episodes that aired while it was backgrounded)
  useEffect(() => {
    kickEpisodeImport();
    const onVis = () => {
      if (document.visibilityState === "visible") kickEpisodeImport();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // hero is pinned server-side to ONE PIECE — always slide 0, no rotation
  const hero = data?.hero?.[0] ?? null;

  return (
    <div className="pb-24">
      {/* Top 10 notifications — floating bell (unread badge) over the hero */}
      <Top10Bell onSelect={onSelect} />

      <HeroBanner
        items={data?.hero ?? []}
        index={0}
        ctaLabel="Details"
        onCta={() => hero && onDetails(hero)}
      />

      {/* Continue Watching — resumes the exact episode + second */}
      {continueItems.length ? (
        <ContinueRow
          items={continueItems.slice(0, 12)}
          onResume={onResume}
          onInfo={(item) => onDetails(animeFromContinue(item))}
          onRemove={(malId) => {
            removeProgress(malId);
            setContinueItems((items) => items.filter((i) => i.malId !== malId));
          }}
        />
      ) : null}

      {/* Suggested For You — right under Continue Watching, driven by it */}
      {continueItems.length && suggestions.length ? (
        <Row
          title={suggestAnchor ? `Because you watched ${suggestAnchor}` : "Suggested For You"}
          items={suggestions}
          onSelect={onSelect}
        />
      ) : null}

      {/* Arriving — Netflix-style coming-soon rail (premieres + episode drops
          with tags and live countdowns), right under the personal rows */}
      <ArrivingRail items={arriving} onSelect={onSelect} />

      {error ? (
        <p className="px-4 mt-8 text-center text-gray-400 text-sm">
          Could not reach the catalog. MAL API may be busy — pull to retry in a moment.
        </p>
      ) : null}

      {!data && !error ? (
        <div className="flex gap-2 px-4 mt-6">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="w-[126px] h-[178px] md:w-[150px] md:h-[212px] lg:w-[172px] lg:h-[243px] rounded-[6px] bg-[#161616] animate-pulse" />
          ))}
        </div>
      ) : null}

      {data ? (
        <>
          {data.lastSync.at ? (
            <p className="px-4 mt-2 text-[11px] text-gray-500">Catalog updated {timeAgo(data.lastSync.at)}</p>
          ) : null}
          {data.sections.map((s) => (
            <Fragment key={s.key}>
              {/* Most Watched rides LIVE in the slot the cached payload used
                  to fill (right before Top Airing) */}
              {s.key === "top-airing" && watched.length ? (
                <Row title="Most Watched on Clyle" items={watched} onSelect={onSelect} />
              ) : null}
              <Row
                title={s.title}
                items={s.items}
                onSelect={onSelect}
                onMore={s.key.startsWith("genre-") ? () => onGenre(s.title) : undefined}
              />
            </Fragment>
          ))}
          {/* fallback slot — the rail still shows when Top Airing dropped */}
          {!data.sections.some((s) => s.key === "top-airing") && watched.length ? (
            <Row title="Most Watched on Clyle" items={watched} onSelect={onSelect} />
          ) : null}
        </>
      ) : null}

      {/* Top 10 This Month — Anime Trending chart ranking, active (ranks swap).
          The rail shows the first 10; "See More" opens the live Top 50 screen. */}
      {top10.length ? (
        <section className="mt-6">
          <div className="flex items-end justify-between px-4 mb-3">
            <h2 className="font-slab text-[21px] font-bold">Top 10 This Month</h2>
            <button
              onClick={onTop50}
              aria-label="See the full Top 50"
              className="flex items-center gap-0.5 text-[12px] font-semibold text-gray-400 hover:text-white active:scale-95 transition pb-0.5"
            >
              See More
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          </div>
          <div className="flex gap-2 overflow-x-auto no-scrollbar px-4 pb-1">
            {top10.slice(0, 10).map((a, i) => {
              const prev = a.prevRank;
              const movedUp = prev != null && a.rank < prev;
              const movedDown = prev != null && a.rank > prev;
              const isNew = prev == null;
              return (
                <div key={a.malId} className="relative shrink-0 text-left active:scale-[0.97] transition">
                  <span className="absolute -left-0.5 -top-1 z-10 font-slab text-[42px] font-extrabold leading-none text-white drop-shadow-[0_2px_2px_rgba(0,0,0,0.9)]">
                    {i + 1}
                  </span>
                  <PosterCard image={a.image} title={a.title} nextEpisodeAt={a.nextEpisodeAt} onClick={() => onSelect(a)} className="w-[126px] h-[178px] ml-3 md:w-[150px] md:h-[212px] lg:w-[172px] lg:h-[243px]" />
                  <p className="mt-1.5 text-[11px] text-gray-300 truncate w-[126px] ml-3 md:w-[150px] lg:w-[172px]">{a.title}</p>
                  <p className="mt-0.5 text-[10px] ml-3 flex items-center gap-1 min-h-[16px]">
                    {movedUp ? (
                      <span className="shrink-0 text-red-500 font-bold leading-none">▲ {prev - a.rank}</span>
                    ) : movedDown ? (
                      <span className="shrink-0 text-gray-500 font-bold leading-none">▼ {a.rank - prev}</span>
                    ) : isNew ? (
                      <span className="shrink-0 bg-red-600 text-white font-bold px-1 py-[2px] rounded-[3px] text-[9px] leading-none tracking-wide">NEW</span>
                    ) : null}
                  </p>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}
