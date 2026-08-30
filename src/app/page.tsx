"use client";

import { useCallback, useEffect, useState } from "react";
import type { AnimeLite } from "@/lib/types";
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

type View =
  | { name: "home" }
  | { name: "details"; anime: AnimeLite }
  | { name: "episodes"; anime: AnimeLite }
  | { name: "watch"; anime: AnimeLite; ep: number; lang: "sub" | "dub" }
  | { name: "genres" }
  | { name: "genre"; genre: string }
  | { name: "latest" }
  | { name: "search" }
  | { name: "mylist" };

export default function Page() {
  const [stack, setStack] = useState<View[]>([{ name: "home" }]);
  const [tab, setTab] = useState<TabKey>("home");

  const view = stack[stack.length - 1];

  const push = useCallback((v: View) => setStack((s) => [...s, v]), []);
  const pop = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);

  const goTab = useCallback(
    (t: TabKey) => {
      setTab(t);
      setStack([{ name: t === "home" ? "home" : t } as View]);
    },
    [],
  );

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

  return (
    <div className="min-h-screen bg-black">
      <div className="max-w-[560px] mx-auto min-h-screen bg-black border-x border-[#141414]">
        {view.name === "home" ? (
          <HomeView
            onSelect={openAnime}
            onDetails={openAnime}
            onWatch={(a) => push({ name: "watch", anime: a, ep: 1, lang: "sub" })}
          />
        ) : null}

        {view.name === "details" ? (
          <DetailsView
            anime={view.anime}
            onBack={pop}
            onSelect={openAnime}
            onWatch={(a) => push({ name: "watch", anime: a, ep: 1, lang: "sub" })}
            onEpisodes={(a) => push({ name: "episodes", anime: a })}
          />
        ) : null}

        {view.name === "episodes" ? (
          <EpisodesView
            anime={view.anime}
            onBack={pop}
            onWatchEpisode={(ep) => push({ name: "watch", anime: view.anime, ep, lang: "sub" })}
          />
        ) : null}

        {view.name === "watch" ? (
          <WatchView
            anime={view.anime}
            episode={view.ep}
            lang={view.lang}
            onBack={pop}
            onEpisodeChange={(ep, lang) => setStack((s) => [...s.slice(0, -1), { name: "watch", anime: view.anime, ep, lang }])}
          />
        ) : null}

        {view.name === "genres" ? <GenresView onSelect={(genre) => push({ name: "genre", genre })} /> : null}

        {view.name === "genre" ? <GenreView genre={view.genre} onBack={pop} onSelect={openAnime} /> : null}

        {view.name === "latest" ? <LatestView onSelect={openAnime} /> : null}

        {view.name === "search" ? <SearchView onSelect={openAnime} /> : null}

        {view.name === "mylist" ? <MyListView onSelect={openAnime} /> : null}
      </div>

      {view.name !== "watch" ? <BottomNav active={tab} onNavigate={goTab} /> : null}
    </div>
  );
}
