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
import type { Lang, ServerId } from "@/lib/zoko";

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
  | { name: "profile" };

type NavDir = "push" | "pop" | "fade";

interface ScreenAnim {
  dir: NavDir;
  prev: View;
  nonce: number;
}

/** Build a minimal AnimeLite from a Continue Watching row so the player can start instantly. */
function animeFromContinue(item: ContinueItem): AnimeLite {
  return {
    malId: item.malId,
    title: item.title,
    titleEnglish: null,
    image: item.image,
    banner: item.banner,
    synopsis: null,
    type: item.type,
    ratingShort: null,
    status: null,
    airing: false,
    season: null,
    year: null,
    durationMin: null,
    score: null,
    rank: null,
    popularity: null,
    totalEpisodes: item.totalEpisodes || item.episode,
    genres: [],
    inCatalog: true,
    source: "seed",
  };
}

export default function Page() {
  const [stack, setStack] = useState<View[]>([{ name: "home" }]);
  const [tab, setTab] = useState<TabKey>("home");
  const [anim, setAnim] = useState<ScreenAnim | null>(null);

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

  const openAnime = useCallback(
    (a: AnimeLite) => push({ name: "details", anime: a }),
    [push],
  );

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
        server: item.server === "kiwi" ? "kiwi" : "zoko",
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
            onBack={pop}
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
        return <ProfileView onResume={resumeWatching} />;
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
    </div>
  );
}
