"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AnimeLite, ContinueItem } from "@/lib/types";
import BottomNav, { type TabKey } from "@/components/anime/BottomNav";
import HomeView from "@/components/views/HomeView";
import DetailsView from "@/components/views/DetailsView";
import EpisodesView from "@/components/views/EpisodesView";
import WatchView from "@/components/views/WatchView";
import GenresView from "@/components/views/GenresView";
import GenreView from "@/components/views/GenreView";
import SearchView from "@/components/views/SearchView";
import MyListView from "@/components/views/MyListView";
import LatestView from "@/components/views/LatestView";
import ProfileView from "@/components/views/ProfileView";
import SettingsView from "@/components/views/SettingsView";
import Top50View from "@/components/views/Top50View";
import type { Lang, ServerId } from "@/lib/zoko";
import { isBackupServer } from "@/lib/zoko";
import { animeFromContinue, minimalLite, readAppSettings, applySettingsToDocument } from "@/lib/client-store";
import { runIncomingTransfer, transferIdOk, parseTransferProgress, type TransferResult } from "@/lib/transfer";
import SaveProgressBanner from "@/components/SaveProgressBanner";

type View =
  | { name: "home" }
  | { name: "details"; anime: AnimeLite }
  | { name: "episodes"; anime: AnimeLite }
  | { name: "watch"; anime: AnimeLite; ep: number; lang: Lang; server: ServerId }
  | { name: "genres" }
  | { name: "genre"; genre: string }
  | { name: "latest" }
  | { name: "search" }
  | { name: "mylist" }
  | { name: "profile" }
  | { name: "settings" }
  | { name: "top50" };

type NavDir = "push" | "pop" | "fade";

interface ScreenAnim {
  dir: NavDir;
  prev: View;
  nonce: number;
}

// animeFromContinue moved to @/lib/client-store (shared with the CW (i) button)

export default function Page() {
  const [stack, setStack] = useState<View[]>([{ name: "home" }]);
  const [tab, setTab] = useState<TabKey>("home");
  const [anim, setAnim] = useState<ScreenAnim | null>(null);
  const [transfer, setTransfer] = useState<TransferResult | null>(null);

  const view = stack[stack.length - 1];

  const navKind = useRef<"push" | "pop" | "tab">("push");
  const nonceRef = useRef(0);
  const prevTopRef = useRef<View>(stack[0]);
  const prevLenRef = useRef(1);

  const push = useCallback((v: View) => {
    navKind.current = "push";
    setStack((s) => [...s, v]);
  }, []);
  const pop = useCallback(() => {
    navKind.current = "pop";
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  }, []);

  const goTab = useCallback((t: TabKey) => {
    setTab(t);
    navKind.current = "tab";
    setStack((s) => {
      const next: View = { name: t === "home" ? "home" : t } as View;
      // tapping the tab you are already on (single view) — no animation
      const top = s[s.length - 1];
      if (s.length === 1 && top.name === next.name) {
        prevTopRef.current = next; // skip effect animation
        return s;
      }
      return [next];
    });
  }, []);

  // Settings -> the document, on every boot: accent variables, the subtitle
  // ::cue rule and the custom app icon all live in <head>, which resets on
  // every full load — re-apply before the first paint of the player.
  useEffect(() => {
    applySettingsToDocument(readAppSettings());
  }, []);

  /* Derive the transition (direction + leaving pane) whenever the stack top changes. */
  useEffect(() => {
    const top = stack[stack.length - 1];
    const prev = prevTopRef.current;
    const prevLen = prevLenRef.current;
    prevTopRef.current = top;
    prevLenRef.current = stack.length;
    if (prev === top) return;

    // episode/lang/server change inside the player — swap content, don't slide
    if (prev.name === "watch" && top.name === "watch" && prev.anime.malId === top.anime.malId) return;
    // same single page re-selected — nothing to animate
    if (prev.name === top.name && stack.length === 1 && prevLen === 1) return;

    let dir: NavDir;
    if (prev.name === "watch" || top.name === "watch") dir = "fade"; // player: fade through black
    else if (navKind.current === "tab") dir = "fade";
    else dir = stack.length > prevLen ? "push" : "pop";

    const nonce = ++nonceRef.current;
    setAnim({ dir, prev, nonce });
    const t = window.setTimeout(() => {
      setAnim((a) => (a && a.nonce === nonce ? null : a));
    }, 340);
    return () => window.clearTimeout(t);
  }, [stack]);

  // Android-style hardware back support
  useEffect(() => {
    const onPop = () => {
      if (stack.length > 1) {
        pop();
        window.history.pushState(null, "", "");
      }
    };
    window.history.pushState(null, "", "");
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [stack.length, pop]);

  /** Exit-the-player = homepage (user ask). goTab("home") resets the stack to
   *  the home root and syncs the bottom nav — no episodes view left underneath. */
  const goTabHome = useCallback(() => goTab("home"), [goTab]);

  const openAnime = useCallback(
    (a: AnimeLite) => push({ name: "details", anime: a }),
    [push],
  );

  // Web Push deep link — notifications carry /?open={malId}; landing on it
  // opens that anime directly (DetailsView re-enriches by malId) and the
  // query is cleaned so Back / reload doesn't re-open it.
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("open");
    const id = Number(raw);
    if (raw && Number.isFinite(id) && id > 0) {
      openAnime(minimalLite(id, `Anime ${id}`, null));
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [openAnime]);

  // Progress transfer handoff — a mirror site navigates here with
  // ?migrate=<oldDeviceId>&ml=<favoriteIds>&p=<packedHistory>. The URL is the
  // only channel that legally crosses the origin boundary, so this is how a
  // stranded anonymous history follows its owner to the main site — the `p`
  // payload carries the device's FULL local history (the server copy can
  // lag). The query is cleaned first so Back / reload can never double-run
  // it (the copy itself is idempotent — newer-wins server-side — but one
  // run is one toast).
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const from = sp.get("migrate");
    if (!transferIdOk(from)) return;
    const ml = (sp.get("ml") ?? "")
      .split(",")
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 150);
    const rows = parseTransferProgress(sp.get("p"));
    window.history.replaceState(null, "", window.location.pathname);
    let alive = true;
    runIncomingTransfer(from as string, ml, rows)
      .then((r) => {
        if (alive && (r.copied > 0 || r.total > 0 || r.favorites > 0 || r.carried > 0)) setTransfer(r);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // the toast dismisses itself
  useEffect(() => {
    if (!transfer) return;
    const t = window.setTimeout(() => setTransfer(null), 9000);
    return () => window.clearTimeout(t);
  }, [transfer]);

  /** Continue Watching tap — straight into the episode at the saved second.
   *  The episode list is pushed UNDER the player so Back (arrow, top-left)
   *  lands on that anime's episode grid instead of dumping you home. */
  const resumeWatching = useCallback(
    (item: ContinueItem) => {
      const ep = Math.max(1, item.episode);
      const mini = animeFromContinue(item);
      push({ name: "episodes", anime: mini });
      push({
        name: "watch",
        anime: mini,
        ep,
        lang: item.lang === "dub" ? "dub" : "sub",
        // backup-server sessions resume on their own server when we know it;
        // unknown/stale ids land on Zoko (the dub chain still backfills)
        server: item.server === "kiwi" ? "kiwi" : isBackupServer(item.server) ? item.server : "zoko",
      });
    },
    [push],
  );

  const renderView = (v: View) => {
    switch (v.name) {
      case "home":
        return (
          <HomeView
            onSelect={openAnime}
            onDetails={openAnime}
            onWatch={(a) => push({ name: "episodes", anime: a })}
            onResume={resumeWatching}
            onTop50={() => push({ name: "top50" })}
            onGenre={(genre) => push({ name: "genre", genre })}
          />
        );
      case "details":
        return (
          <DetailsView
            anime={v.anime}
            onBack={pop}
            onSelect={openAnime}
            onWatch={(a) => push({ name: "episodes", anime: a })}
            onEpisodes={(a) => push({ name: "episodes", anime: a })}
          />
        );
      case "episodes":
        return (
          <EpisodesView
            anime={v.anime}
            onBack={pop}
            onWatchEpisode={(ep, server, lang) => push({ name: "watch", anime: v.anime, ep, lang, server })}
          />
        );
      case "watch":
        return (
          <WatchView
            anime={v.anime}
            episode={v.ep}
            lang={v.lang}
            server={v.server}
            // exiting the player ALWAYS lands on the homepage (user ask) —
            // goTab resets the stack to the home root, so no episodes grid
            // is left sitting underneath the fade
            onBack={goTabHome}
            onEpisodeChange={(ep, lang, server) =>
              setStack((s) => [...s.slice(0, -1), { name: "watch", anime: v.anime, ep, lang, server }])
            }
          />
        );
      case "genres":
        return <GenresView onSelect={(genre) => push({ name: "genre", genre })} />;
      case "genre":
        return <GenreView genre={v.genre} onBack={pop} onSelect={openAnime} />;
      case "latest":
        return <LatestView onSelect={openAnime} />;
      case "search":
        return <SearchView onSelect={openAnime} />;
      case "mylist":
        return <MyListView onSelect={openAnime} />;
      case "profile":
        return <ProfileView onSettings={() => push({ name: "settings" })} />;
      case "settings":
        return <SettingsView onBack={pop} />;
      case "top50":
        return <Top50View onBack={pop} onSelect={openAnime} />;
    }
  };

  // pane keys stay stable across the animation so scroll positions survive
  const topKey = `${stack.length}-${view.name}`;
  const inClass =
    anim?.dir === "push" ? "anim-push-in" : anim?.dir === "pop" ? "anim-pop-under" : anim ? "anim-fade-in" : "";
  const outClass =
    anim?.dir === "push" ? "anim-push-under" : anim?.dir === "pop" ? "anim-pop-out" : "anim-fade-out";
  const inZ = anim?.dir === "pop" ? "z-10" : "z-20";

  return (
    <div className="min-h-screen bg-black">
      {/* phone frame < md; tablet column at md; full-bleed desktop at lg
          (BottomNav becomes a 76px left rail there, so panes get lg:left-[76px]) */}
      <div className="relative w-full max-w-[560px] md:max-w-[820px] lg:max-w-none mx-auto h-[100dvh] bg-black border-x border-[#141414] overflow-hidden">
        {/* current (incoming) pane */}
        <div
          key={topKey}
          className={`absolute inset-0 overflow-y-auto overscroll-contain bg-black ${
            view.name !== "watch" ? "lg:left-[76px]" : ""
          } ${inClass} ${inZ}`}
        >
          {renderView(view)}
        </div>

        {/* leaving pane (only during a transition) */}
        {anim ? (
          <div
            key={`out-${anim.nonce}`}
            data-leaving="true"
            className={`absolute inset-0 overflow-y-auto overscroll-contain bg-black ${
              anim.prev.name !== "watch" ? "lg:left-[76px]" : ""
            } ${outClass} pointer-events-none ${
              anim.dir === "pop" ? "z-20" : "z-10"
            }`}
          >
            {renderView(anim.prev)}
          </div>
        ) : null}
      </div>

      {view.name !== "watch" ? <BottomNav active={tab} onNavigate={goTab} /> : null}

      {/* progress banner — mirrors: move-to-main handoff; main site:
          save-your-progress (Google sign-in). Hidden in the player and
          while the transfer toast is showing */}
      <SaveProgressBanner active={view.name !== "watch" && !transfer} />

      {/* transfer result toast — tappable to dismiss */}
      {transfer ? (
        <button
          onClick={() => setTransfer(null)}
          className="fixed bottom-20 lg:bottom-6 left-1/2 -translate-x-1/2 z-50 max-w-[92%] rounded-full bg-[#1d1d1d] border border-white/15 px-4 py-2.5 text-[12.5px] font-semibold text-gray-100 shadow-2xl active:scale-95 transition text-center"
        >
          {(transfer.total > 0 || transfer.carried > 0) && transfer.copied + transfer.carried > 0 ? (
            <>
              Restored {transfer.copied + transfer.carried}
              {transfer.total > transfer.copied ? ` of ${transfer.total + transfer.carried}` : ""} episode
              {transfer.copied + transfer.carried === 1 ? "" : "s"} of Continue Watching
            </>
          ) : null}
          {transfer.total > 0 && transfer.favorites > 0 ? " · " : ""}
          {transfer.favorites > 0 ? (
            <>
              {transfer.favorites} favorite{transfer.favorites === 1 ? "" : "s"} added to My List
            </>
          ) : null}
        </button>
      ) : null}
    </div>
  );
}
