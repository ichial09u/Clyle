"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowUpDown, Download, MonitorPlay, Search, X } from "lucide-react";
import type { AnimeLite, EpisodesPayload } from "@/lib/types";
import EpisodeDownloadSheet from "@/components/anime/EpisodeDownloadSheet";
import {
  fetchServerProgress,
  getEpProgressAll,
  getLangPref,
  setLangPref,
  useProgressVersion,
} from "@/lib/client-store";
import { type Lang, type ServerId, MEGAPLAY_IFRAME_SERVER } from "@/lib/zoko";

/** percent -> red bar width inside the episode button (8% padding each side) */
function barWidth(p: { pos: number; dur: number; completed: boolean } | undefined): number {
  if (!p) return 0;
  if (p.completed) return 100;
  if (!p.dur || p.dur <= 0) return 0;
  return Math.min(100, Math.round((p.pos / p.dur) * 100));
}

/**
 * NEW badge — only for a genuine "new episode dropped" batch. A backlog
 * import (whole series / migration) re-stamps addedAt for hundreds of
 * episodes, and none of those should be flagged. Real weekly drops are a
 * handful of rows, so cap the badge to small recent batches.
 */
function computeNewEpisodes(episodes: Array<{ number: number; addedAt: string }>): Set<number> {
  const cutoff = Date.now() - 24 * 3600_000;
  const recent = episodes.filter((e) => Date.now() - Date.parse(e.addedAt) < cutoff);
  if (recent.length === 0 || recent.length > 15) return new Set();
  return new Set(recent.map((e) => e.number));
}

/**
 * Does a real DUB exist for THIS episode? Same truthing the server sheet
 * uses: per-server boundary (dubThrough), proven holes (dubMissing), the
 * anime-level verdict as fallback when the boundary was never probed, and
 * the Anivexa backup network as the last resort.
 */
function dubForEpisode(d: EpisodesPayload | null, n: number): boolean {
  if (!d) return false;
  if ((d.dubMissing ?? []).includes(n)) return false;
  const bt = d.dubThrough ?? { s1: null, s2: null };
  if (bt.s1 != null && n <= bt.s1) return true;
  if (bt.s2 != null && n <= bt.s2) return true;
  if (bt.s1 == null && bt.s2 == null) return (d.dubServers?.length ?? 0) > 0;
  return (d.backupDub ?? []).some((b) => (b.covered ?? []).includes(n));
}

export default function EpisodesView({
  anime,
  onBack,
  onWatchEpisode,
}: {
  anime: AnimeLite;
  onBack: () => void;
  onWatchEpisode: (ep: number, server: ServerId, lang: Lang) => void;
}) {
  const [data, setData] = useState<EpisodesPayload | null>(null);
  const [loadedFor, setLoadedFor] = useState<number | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [desc, setDesc] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);
  const [picked, setPicked] = useState<number | null>(null); // episode awaiting server choice
  const [dlEp, setDlEp] = useState<number | null>(null); // episode awaiting the download sheet
  // Megaplay embed pre-flight verdict for the OPEN server sheet's episode:
  // Megaplay's catalog rots (takedowns delete files / unmapped shows) and
  // the last-resort "DUB Megaplay" button used to hand the viewer straight
  // to their 410 error page. A definitive false hides the button live.
  // null = unchecked/unknown — optimistic, matching pre-verdict behavior.
  const [megaVerdict, setMegaVerdict] = useState<boolean | null>(null);
  // season dropdown (franchise entries like South Park carry every season on
  // one row) — null = flat list (payload has no seasons)
  const [seasonIdx, setSeasonIdx] = useState<number | null>(null);
  const progressVersion = useProgressVersion();

  // The grid used to sit on skeletons FOREVER when this one fetch failed
  // (cold 504, dead network cell, phone backgrounded mid-flight) — the catch
  // just kept the skeleton and nothing ever retried. Now: 3 attempts with
  // backoff, then an honest "couldn't load" state with a retry button.
  const loadEpisodes = useCallback(() => {
    let cancelled = false;
    setLoadFailed(false);
    (async () => {
      const delays = [0, 1_200, 3_000];
      for (let attempt = 0; attempt < delays.length; attempt++) {
        if (delays[attempt]) await new Promise((r) => setTimeout(r, delays[attempt]));
        if (cancelled) return;
        try {
          const ctrl = new AbortController();
          const kill = setTimeout(() => ctrl.abort(), 12_000);
          const res = await fetch(`/api/anime/${anime.malId}/episodes`, { signal: ctrl.signal });
          clearTimeout(kill);
          if (!res.ok) continue;
          const payload = (await res.json()) as EpisodesPayload;
          if (!cancelled) {
            setData(payload);
            setLoadedFor(anime.malId);
            // The route deferred its freshness check (AniList was slow) — a
            // brand-new episode may be importing right now. Refetch shortly
            // so it appears HERE, without the user leaving and coming back.
            if (payload.freshnessPending) {
              for (const delay of [3_000, 8_000]) {
                setTimeout(async () => {
                  if (cancelled) return;
                  try {
                    const res2 = await fetch(`/api/anime/${anime.malId}/episodes`);
                    if (!res2.ok || cancelled) return;
                    const p2 = (await res2.json()) as EpisodesPayload;
                    if (!cancelled) setData(p2);
                  } catch {
                    /* best effort */
                  }
                }, delay);
              }
            }
            return;
          }
        } catch {
          /* try again */
        }
      }
      if (!cancelled) setLoadFailed(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [anime.malId]);

  useEffect(() => loadEpisodes(), [loadEpisodes]);

  // red bars: local progress immediately, server rows merged in (fresh storage / other device)
  useEffect(() => {
    fetchServerProgress(anime.malId).catch(() => undefined);
  }, [anime.malId]);

  const episodesData = loadedFor === anime.malId ? data : null;

  // Megaplay embed pre-flight for the open server sheet — only fires when
  // the sheet's last-resort Megaplay button would show (main chain can't
  // dub the episode and no backup covers it). 24h-cached server verdict;
  // network trouble -> null -> the button stays optimistic.
  useEffect(() => {
    if (picked == null) {
      setMegaVerdict(null);
      return;
    }
    const bt = episodesData?.dubThrough ?? { s1: null, s2: null };
    const missing = episodesData?.dubMissing ?? [];
    const animeLevel = episodesData?.dubServers ?? ["zoko", "kiwi"];
    const canDub =
      !missing.includes(picked) &&
      (["zoko", "kiwi"] as const).some((s) => {
        const thru = s === "zoko" ? bt.s1 : bt.s2;
        return thru != null ? picked <= thru : animeLevel.includes(s);
      });
    const backupsCover = (episodesData?.backupDub ?? []).some((b) =>
      (b.covered ?? []).includes(picked),
    );
    setMegaVerdict(null);
    if (canDub || backupsCover) return; // Megaplay button never shows here
    let dead = false;
    fetch(`/api/anime/${anime.malId}/megaplay-embed?ep=${picked}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { ok?: boolean | null } | null) => {
        if (!dead) setMegaVerdict(d && typeof d.ok === "boolean" ? d.ok : null);
      })
      .catch(() => {
        if (!dead) setMegaVerdict(null);
      });
    return () => {
      dead = true;
    };
  }, [picked, episodesData, anime.malId]);

  const numbers = useMemo(() => {
    // per-season WCO entries (South Park) ship the EXACT numbers to render —
    // their source can have gaps (S28 starts at 2) that a contiguous
    // 1..total range would render as dead tiles
    const exact = episodesData?.numbers;
    if (exact?.length) {
      const filteredExact = filter ? exact.filter((n) => String(n).includes(filter)) : exact;
      return desc ? [...filteredExact].reverse() : filteredExact;
    }
    const seasons = episodesData?.seasons;
    const range = seasons && seasonIdx != null ? seasons[seasonIdx] : null;
    const from = range ? range.from : 1;
    const to = range ? range.to : (episodesData?.total ?? anime.totalEpisodes ?? 0);
    const list: number[] = [];
    for (let n = from; n <= to; n++) list.push(n);
    const filtered = filter ? list.filter((n) => String(n).includes(filter)) : list;
    return desc ? [...filtered].reverse() : filtered;
  }, [episodesData, anime.totalEpisodes, desc, filter, seasonIdx]);

  // episode-number → title lookup: the old `episodes.find()` inside the grid
  // was O(episodes²) per render (One Piece = 1100 buttons × 1100 scans)
  const titlesByNumber = useMemo(() => {
    const m = new Map<number, string>();
    for (const e of episodesData?.episodes ?? []) if (e.title) m.set(e.number, e.title);
    return m;
  }, [episodesData]);

  const epProgress = progressVersion >= 0 ? getEpProgressAll(anime.malId) : {};

  // default the dropdown to the season the viewer is furthest into (run
  // once per loaded payload — never override a season they picked themselves)
  const seasonTouched = useRef(false);
  useEffect(() => {
    const seasons = episodesData?.seasons;
    if (!seasons?.length || seasonTouched.current) return;
    let furthest = 0;
    for (const [k, v] of Object.entries(epProgress)) {
      const n = parseInt(k, 10);
      if (Number.isFinite(n) && n > furthest && (v.pos > 0 || v.completed)) furthest = n;
    }
    const idx = seasons.findIndex((s) => furthest >= s.from && furthest <= s.to);
    setSeasonIdx(idx >= 0 ? idx : 0);
     
  }, [loadedFor]);

  const newEpisodes = useMemo(
    () => computeNewEpisodes(episodesData?.episodes ?? []),
    [episodesData],
  );

  const openServerSheet = (n: number) => {
    setPicked(n);
    // Warm the stream resolution while the sheet is open: the viewer's most
    // likely choice (their last-used language/server) starts resolving NOW,
    // so the button click lands on warm caches and the player starts in
    // hundreds of ms instead of waiting out the whole resolve chain. Only
    // fires when that combo is actually offered on this episode (a hidden
    // DUB button must not trigger a doomed full backfill chain).
    try {
      const p = getLangPref(anime.malId);
      const bt = data?.dubThrough ?? { s1: null, s2: null };
      const thru = p.server === "zoko" ? bt.s1 : bt.s2;
      const dubOk =
        p.lang === "sub" ||
        (!(data?.dubMissing ?? []).includes(n) && (thru == null || n <= thru) && (data?.dubServers?.length ?? 0) > 0);
      if (dubOk) {
        void fetch(`/api/stream?malId=${anime.malId}&ep=${n}&lang=${p.lang}&server=${p.server}`).catch(() => undefined);
      }
    } catch {
      /* prefetch is best-effort */
    }
  };
  const play = (lang: Lang, server: ServerId) => {
    if (picked != null) onWatchEpisode(picked, server, lang);
    // remember for next time — the sheet will lead with this language/server
    // (the lang-pref store only knows the main servers; a backup pick lands
    // on zoko so the NEXT sheet still leads with the right language)
    setLangPref(anime.malId, { lang, server: server === "kiwi" ? "kiwi" : "zoko" });
    setPicked(null);
  };

  // what the viewer last watched here (per anime -> global -> sub/zoko):
  // back from the player into this list no longer "switches to sub" when you
  // were in DUB — the sheet leads with your language and highlights it
  const pref = getLangPref(anime.malId);
  const prefWorks = pref.lang === "sub" || episodesData?.hasDub !== false;

  return (
    <div className="pb-24 min-h-screen lg:max-w-[1100px] lg:mx-auto">
      {/* header */}
      <header className="sticky top-0 z-30 bg-black/95 backdrop-blur">
        <div className="flex items-center gap-3 px-3 pt-3 pb-2">
          <button onClick={onBack} className="p-1 -ml-1 hover:opacity-80 active:scale-95 transition" aria-label="Back">
            <ArrowLeft className="w-6 h-6" />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="font-slab text-[19px] font-bold leading-tight truncate">{episodesData?.title ?? anime.title}</h1>
            <p className="text-[12px] text-gray-400">Episodes{episodesData?.airing ? " • airing" : ""}</p>
          </div>
          <button
            onClick={() => setDesc((d) => !d)}
            className={`p-2 hover:opacity-80 active:scale-95 transition ${desc ? "text-[#ff5252]" : ""}`}
            aria-label="Toggle sort order"
            title={desc ? "Newest first" : "Oldest first"}
          >
            <ArrowUpDown className="w-5 h-5" />
          </button>
          <button
            onClick={() => setFilter((f) => (f === null ? "" : null))}
            className="p-2 hover:opacity-80 active:scale-95 transition"
            aria-label="Find episode"
          >
            <Search className="w-5 h-5" />
          </button>
        </div>
        {/* red loading line while the episode list is being fetched */}
        {!episodesData && !loadFailed ? <div className="load-line h-[2px] mx-3 mb-1.5 rounded-full bg-white/10" /> : null}
        {/* season dropdown — franchise entries (South Park) carry every
            season on one row; a native select keeps it one-tap on phones */}
        {episodesData?.seasons?.length ? (
          <div className="px-4 pb-2.5">
            <select
              value={seasonIdx ?? 0}
              onChange={(e) => {
                seasonTouched.current = true;
                setSeasonIdx(parseInt(e.target.value, 10));
              }}
              aria-label="Select season"
              className="w-full appearance-none rounded-md bg-[#1c1c1c] ring-1 ring-inset ring-white/10 hover:ring-white/25 px-3 py-2 text-[13.5px] font-semibold text-gray-100 outline-none cursor-pointer"
            >
              {episodesData.seasons.map((s, i) => (
                <option key={s.season} value={i} className="bg-[#1c1c1c]">
                  {s.label} · {s.to - s.from + 1}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {filter !== null ? (
          <div className="px-4 pb-2.5">
            <div className="flex items-center bg-[#1c1c1c] rounded-md px-3">
              <Search className="w-4 h-4 text-gray-400 mr-2" />
              <input
                autoFocus
                inputMode="numeric"
                value={filter}
                onChange={(e) => setFilter(e.target.value.replace(/\D/g, ""))}
                placeholder="Jump to episode number…"
                className="flex-1 bg-transparent py-2 text-[14px] outline-none placeholder:text-gray-500"
              />
              {filter ? (
                <button onClick={() => setFilter("")} aria-label="Clear">
                  <X className="w-4 h-4 text-gray-400" />
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        {episodesData?.newlyAdded ? (
          <p className="px-4 pb-2 text-[11.5px] text-[#ff8a80]">
            {episodesData.newlyAdded} new episode{episodesData.newlyAdded > 1 ? "s" : ""} imported just now
          </p>
        ) : null}
      </header>

      {/* grid */}
      {!episodesData && loadFailed ? (
        <div className="px-4 pt-10 flex flex-col items-center gap-3 text-center">
          <p className="text-gray-400 text-sm">Couldn&apos;t load the episode list.</p>
          <button
            onClick={loadEpisodes}
            className="bg-[#d32f2f] hover:bg-[#b71c1c] text-white text-[12.5px] font-bold rounded-full px-5 py-2 transition active:scale-95"
          >
            Try again
          </button>
        </div>
      ) : !episodesData ? (
        <div className="grid grid-cols-5 md:grid-cols-8 lg:grid-cols-10 gap-2 px-4 pt-4">
          {Array.from({ length: 20 }).map((_, i) => (
            <div key={i} className="h-[46px] rounded-md bg-[#161616] animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-5 md:grid-cols-8 lg:grid-cols-10 gap-2 px-4 pt-3">
          {numbers.map((n) => {
            const pr = epProgress[String(n)];
            const pct = barWidth(pr);
            return (
              <div key={n} className="relative">
                <button
                  onClick={() => openServerSheet(n)}
                  className="w-full h-[46px] rounded-md bg-[#1c1c1c] hover:bg-[#282828] active:scale-95 transition text-[14px] font-medium overflow-hidden"
                  title={titlesByNumber.get(n) ?? `Episode ${n}${pct ? ` — ${pct}% watched` : ""}`}
                >
                  {n}
                  {/* accurate watch-progress bar (red), sits at the bottom of the button */}
                  {pct > 0 ? (
                    <span className="absolute left-[8%] right-[8%] bottom-[3px] h-[3px] rounded-full bg-white/12 overflow-hidden">
                      <span className="block h-full bg-[#d32f2f] rounded-full" style={{ width: `${pct}%` }} />
                    </span>
                  ) : null}
                </button>
                {newEpisodes.has(n) ? (
                  <span className="absolute -top-1 -right-1 bg-[#d32f2f] text-[8px] font-bold px-1 py-[1px] rounded-full z-10">
                    NEW
                  </span>
                ) : null}
                {/* per-episode download chip — opens the download sheet */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setDlEp(n);
                  }}
                  className="absolute -top-1.5 -left-1.5 z-10 w-[22px] h-[22px] rounded-full bg-black/85 border border-white/15 flex items-center justify-center hover:bg-[#d32f2f] hover:border-[#d32f2f] active:scale-90 transition shadow-md"
                  title={`Download episode ${n}`}
                  aria-label={`Download episode ${n}`}
                >
                  <Download className="w-[11px] h-[11px] text-gray-200" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {episodesData && numbers.length === 0 ? (
        <p className="px-4 mt-10 text-center text-gray-400 text-sm">No episodes match &ldquo;{filter}&rdquo;.</p>
      ) : null}

      {/* server picker sheet — mirrors the reference: "Choose a server & a
          server doesn't work, please choose another" + SUB/DUB Server #1/#2.
          Rendered through a portal to <body>: the view pane is a stacking
          context (z-20), so a fixed z-[60] sheet inside it still painted UNDER
          the z-40 bottom nav and the DUB row was cut off on phones. The portal
          hoists the sheet to the root stacking context where z-[60] > z-40.
          Safe-area padding keeps the buttons clear of the iOS home indicator. */}
      {picked != null
        ? createPortal(
          <div className="fixed inset-0 z-[60] bg-black/60 anim-backdrop flex items-end sm:items-center justify-center" onClick={() => setPicked(null)}>
            <div
              className="w-full sm:max-w-[400px] bg-[#151515] border-t sm:border sm:border-[#242424] sm:rounded-xl rounded-t-xl shadow-2xl overflow-hidden anim-sheet-up"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-label="Choose a server"
            >
              <div className="px-4 pt-4 pb-1 flex items-center justify-between">
                <h3 className="font-slab text-[16px] font-bold">Episode {picked}</h3>
                <button onClick={() => setPicked(null)} className="text-gray-400 hover:text-white" aria-label="Close">
                  <X className="w-5 h-5" />
                </button>
              </div>
              {(() => {
                const pr = epProgress[String(picked)];
                const pct = barWidth(pr);
                return pct > 0 ? (
                  <p className="px-4 text-[11.5px] text-[#ff8a80] pb-1">
                    {pr?.completed ? "Episode finished — replay from the start" : `You were ${pct}% through — it will resume automatically`}
                  </p>
                ) : null;
              })()}
              <p className="px-4 pb-3 text-[11.5px] text-gray-400">Choose a server &amp; a server doesn&apos;t work, please choose another</p>
              <div className="px-3" style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 20px)" }}>
                {(() => {
                  // SUB is always on both servers. DUB buttons appear ONLY
                  // where a real dub actually exists for THIS episode:
                  // the per-episode boundary (dubThrough) gates them — an
                  // anime can be dubbed while its newest arc isn't yet
                  // (One Piece/Elbaph), and sub-only / not-yet-dubbed shows
                  // get no DUB buttons at all. null boundary = unprobed —
                  // fall back to the anime-level dubServers verdict.
                  const bt = episodesData?.dubThrough ?? { s1: null, s2: null };
                  // holes inside a dubbed range (DAN DA DAN S1 eps 4-6): exact
                  // episodes with a definitive no-dub proof on BOTH chains
                  const missing = episodesData?.dubMissing ?? [];
                  const animeLevel = episodesData?.dubServers ?? ["zoko", "kiwi"];
                  const dubFor = (server: "zoko" | "kiwi"): boolean => {
                    if (missing.includes(picked!)) return false; // proven hole on both chains
                    const thru = server === "zoko" ? bt.s1 : bt.s2;
                    if (thru != null) return picked! <= thru; // 0 = no dub anywhere
                    return animeLevel.includes(server);
                  };
                  // SUB buttons come from the verdicts too (mirror of DUB):
                  // Pokémon-class titles are DUB-ONLY on Zoko/Kiwi — their sub
                  // pages are 200 shells, so those SUB buttons were
                  // guaranteed-dead. unknown/absent = optimistic both.
                  const subLevel = episodesData?.subServers ?? ["zoko", "kiwi"];
                  const all: Array<{ lang: Lang; server: ServerId }> = [
                    ...(subLevel.includes("zoko") ? [{ lang: "sub" as Lang, server: "zoko" as ServerId }] : []),
                    ...(subLevel.includes("kiwi") ? [{ lang: "sub" as Lang, server: "kiwi" as ServerId }] : []),
                    ...(["zoko", "kiwi"] as const)
                      .filter((s) => dubFor(s))
                      .map((s) => ({ lang: "dub" as Lang, server: s })),
                  ];
                  // BACKUP DUB servers (the Anivexa network): a backup button
                  // appears ONLY when the main chain can't dub THIS episode
                  // (no DUB Zoko/Kiwi button here) AND that provider's dub
                  // list covers it — "whoever has that dub gets their server;
                  // if only 1 has it, only 1 dub button".
                  const mainCanDub = dubFor("zoko") || dubFor("kiwi");
                  const backups = !mainCanDub
                    ? (episodesData?.backupDub ?? []).filter(
                        (b) => (b.covered ?? []).includes(picked!),
                      )
                    : [];
                  // MEGAPLAY embed — the dub iframe fallback: when NEITHER the
                  // main chain NOR the backup network can resolve this
                  // episode's dub, Megaplay's MAL-keyed player usually still
                  // carries it (their player decrypts client-side, so it
                  // works where stream extraction can't). DUB only, last.
                  const showMegaplay = !mainCanDub && backups.length === 0 && megaVerdict !== false;
                  const allWithBackups: Array<{ lang: Lang; server: ServerId }> = [
                    ...all,
                    ...backups.map((b) => ({ lang: "dub" as Lang, server: b.server as ServerId })),
                    ...(showMegaplay ? [{ lang: "dub" as Lang, server: MEGAPLAY_IFRAME_SERVER }] : []),
                  ];
                  // your last-used language first (so the top-left button is
                  // what you were watching), then the other language
                  const preferred = prefWorks
                    ? allWithBackups.filter((b) => b.lang === pref.lang)
                    : [];
                  const rest = allWithBackups.filter((b) => !preferred.includes(b));
                  const ordered = [...preferred, ...rest];
                  return (
                    <div className="grid grid-cols-2 gap-2">
                      {ordered.map(({ lang, server }) => {
                        const n: 1 | 2 | null = server === "zoko" ? 1 : server === "kiwi" ? 2 : null;
                        const isBackup = server.startsWith("anivexa-");
                        const isMegaplay = server === MEGAPLAY_IFRAME_SERVER;
                        const backupName =
                          (episodesData?.backupDub ?? []).find((b) => b.server === server)?.name ?? "Backup";
                        const isPref =
                          lang === pref.lang &&
                          (server === pref.server ||
                            (isBackup && pref.server.startsWith("anivexa-")));
                        return (
                          <button
                            key={`${lang}-${server}`}
                            onClick={() => play(lang, server)}
                            title={
                              isPref
                                ? "Your last choice"
                                : isBackup
                                  ? `DUB via ${backupName} (backup server)`
                                  : isMegaplay
                                    ? "DUB via Megaplay's embedded player"
                                    : undefined
                            }
                            className={`flex items-center justify-center gap-2 rounded-lg active:scale-[0.98] transition text-[13px] font-bold py-3 text-center ${
                              isPref
                                ? "bg-[#ff5252] hover:bg-[#ff6b6b] text-white"
                                : isBackup || isMegaplay
                                  ? "bg-[#26263a] hover:bg-[#32324a] text-gray-100"
                                  : "bg-white hover:bg-gray-200 text-black"
                            }`}
                          >
                            <MonitorPlay
                              className={`w-4 h-4 ${
                                isPref ? "text-white" : isBackup || isMegaplay ? "text-[#8f9bff]" : "text-[#d32f2f]"
                              }`}
                            />
                          {(() => {
                            // Western shows (South Park — serverNames present) are
                            // natively English: no SUB/DUB language choice exists,
                            // so the buttons are plain "Server 1"/"Server 2".
                            // Anime keeps the classic "<LANG> Server #N" labels.
                            const spName = (episodesData?.serverNames ?? {})[server as "zoko" | "kiwi"];
                            return isMegaplay
                              ? "DUB Megaplay"
                              : isBackup
                                ? `DUB ${backupName}`
                                : spName
                                  ? `Server ${n}`
                                  : `${lang.toUpperCase()} Server #${n}`;
                          })()}
                          </button>
                        );
                      })}
                    </div>
                  );
              })()}
                {/* download handoff — the "press episode → popup → download" flow */}
                <button
                  onClick={() => {
                    setDlEp(picked);
                    setPicked(null);
                  }}
                  className="mt-3 w-full flex items-center justify-center gap-2 rounded-lg bg-[#1c1c1c] hover:bg-[#282828] ring-1 ring-inset ring-white/10 text-gray-100 text-[13px] font-bold py-2.5 transition active:scale-[0.98]"
                >
                  <Download className="w-4 h-4 text-[#ff5252]" /> Download this episode
                </button>
                {(() => {
                  // no DUB on this episode at all — say which kind of "not yet"
                  const bt = episodesData?.dubThrough ?? { s1: null, s2: null };
                  const noneAtAll =
                    bt.s1 != null && bt.s1 === 0 && bt.s2 != null && bt.s2 === 0;
                  const behindBoundary =
                    (bt.s1 != null && picked! > bt.s1 && bt.s1 > 0) ||
                    (bt.s2 != null && picked! > bt.s2 && bt.s2 > 0) ||
                    (episodesData?.dubMissing ?? []).includes(picked!);
                  const nonePerLevel = (episodesData?.dubServers?.length ?? 0) === 0;
                  // a backup server covering this episode means a DUB *does*
                  // exist (just not on Zoko/Kiwi) — don't claim "no dub"
                  const backupCovers = (episodesData?.backupDub ?? []).some(
                    (b) => (b.covered ?? []).includes(picked!),
                  );
                  // the Megaplay embed button means a dub MIGHT still play —
                  // word the notice around it instead of "no dub at all"
                  const megaplayShown =
                    megaVerdict !== false &&
                    !backupCovers &&
                    !((episodesData?.dubMissing ?? []).includes(picked!)
                      ? false
                      : (bt.s1 != null && picked! <= bt.s1 && bt.s1 > 0) ||
                        (bt.s2 != null && picked! <= bt.s2 && bt.s2 > 0) ||
                        (episodesData?.dubServers?.length ?? 0) > 0);
                  if (backupCovers) {
                    return (
                      <p className="mt-2 text-center text-[10.5px] text-gray-500">
                        English DUB available on the backup servers above
                      </p>
                    );
                  }
                  if (megaplayShown) {
                    return (
                      <p className="mt-2 text-center text-[10.5px] text-gray-500">
                        No DUB on Zoko/Kiwi for this episode — the Megaplay embed above usually carries it
                      </p>
                    );
                  }
                  if (noneAtAll || (!bt.s1 && !bt.s2 && nonePerLevel)) {
                    return <p className="mt-2 text-center text-[10.5px] text-gray-500">No DUB available for this anime yet</p>;
                  }
                  if (behindBoundary) {
                    return <p className="mt-2 text-center text-[10.5px] text-gray-500">No English DUB for this episode yet — SUB only for now</p>;
                  }
                  return null;
                })()}
                {(() => {
                  // zero buttons at all — DUB-ONLY title whose SUB pages are
                  // shells, or a genuinely unstreamable import: say so honestly
                  const subLevel = episodesData?.subServers ?? ["zoko", "kiwi"];
                  const bt = episodesData?.dubThrough ?? { s1: null, s2: null };
                  const animeLevel = episodesData?.dubServers ?? ["zoko", "kiwi"];
                  const anySub = subLevel.length > 0;
                  const anyDub =
                    animeLevel.length > 0 ||
                    (episodesData?.backupDub ?? []).length > 0 ||
                    bt.s1 == null; // unprobed boundary — optimistic
                  if (!anySub && !anyDub) {
                    return <p className="mt-2 text-center text-[10.5px] text-gray-500">No streams available for this title yet</p>;
                  }
                  return null;
                })()}
              </div>
            </div>
          </div>,
          document.body,
          )
        : null}

      {/* per-episode download popup — opened by the tile corner chip or the
          server sheet's "Download this episode" (SUB/DUB + quality + .srt) */}
      {dlEp != null ? (
        <EpisodeDownloadSheet
          anime={anime}
          episode={dlEp}
          episodeTitle={titlesByNumber.get(dlEp) ?? null}
          dubAvailable={dubForEpisode(episodesData, dlEp)}
          durationMin={episodesData?.durationMin ?? anime.durationMin ?? 24}
          onClose={() => setDlEp(null)}
        />
      ) : null}
    </div>
  );
}
