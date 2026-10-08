"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2, X } from "lucide-react";
import type { AnimeLite } from "@/lib/types";
import { Switch } from "@/components/ui/switch";
import { enablePush, getPushSubscriptionJson, pushSupported } from "@/lib/push-client";

/**
 * ANN Tracking — the small circular button on the details page (same size and
 * shell as the floating notification bell) carrying the "climbing the chart"
 * artwork. It tracks a show against the AnimeNewsNetwork encyclopedia: tapping
 * opens a panel with the ANN record (matched title, type, air dates, episodes
 * listed) and a Track switch. Tracking is per-device (localStorage) — the ANN
 * data itself is fetched through /api/ann-track, which searches the ANN
 * encyclopedia and parses the entry server-side.
 */

type AnnMatch = {
  annId: number;
  name: string;
  type: string | null;
  precision: string | null;
  vintage: string | null;
  episodesListed: number | null;
  highestEpisode: number | null;
  totalEps: number | null;
  url: string;
};

const LS_KEY = "clyle:ann-track";

function readTracked(): Record<string, true> {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}") as Record<string, true>;
  } catch {
    return {};
  }
}

export default function TrackButton({ anime }: { anime: AnimeLite }) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"idle" | "loading" | "found" | "none" | "error">("idle");
  const [match, setMatch] = useState<AnnMatch | null>(null);
  const [tracked, setTracked] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTracked(!!readTracked()[String(anime.malId)]);
  }, [anime.malId]);

  // SELF-HEAL: the server half of a tracked show used to vanish on every
  // deploy (fresh /tmp SQLite) while the switch still read "Tracking" from
  // localStorage — news pushes silently stopped. Re-POST the (endpoint,
  // anime) pair whenever the local state says tracked; the server upsert is
  // idempotent and the global log spreads it to every instance.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!readTracked()[String(anime.malId)] || !pushSupported()) return;
      try {
        const sub = await getPushSubscriptionJson();
        if (!sub || cancelled) return;
        await fetch("/api/ann-track/subs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: sub.endpoint,
            keys: sub.keys,
            on: true,
            ann: { malId: anime.malId, annId: null, annName: anime.title, title: anime.titleEnglish || anime.title, image: anime.image },
          }),
        });
      } catch {
        /* best-effort — the next toggle re-syncs anyway */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [anime.malId, anime.title, anime.titleEnglish, anime.image]);

  // tap outside the panel closes it
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, [open]);

  const load = useCallback(async () => {
    setPhase("loading");
    // ANN's main names are English — try the English title first, then romaji
    const titles = Array.from(new Set([anime.titleEnglish ?? "", anime.title].filter(Boolean)));
    for (const q of titles) {
      try {
        const res = await fetch(`/api/ann-track?q=${encodeURIComponent(q)}&malId=${anime.malId}`);
        const data = (await res.json()) as { found?: boolean; match?: AnnMatch };
        if (data?.found && data.match) {
          setMatch(data.match);
          setPhase("found");
          return;
        }
      } catch {
        /* try the next title, else the error state below */
      }
    }
    setPhase("none");
  }, [anime.malId, anime.title, anime.titleEnglish]);

  const onToggleOpen = () => {
    const next = !open;
    setOpen(next);
    if (next && phase === "idle") void load();
  };

  const toggleTracked = async (on: boolean) => {
    const map = readTracked();
    if (on) map[String(anime.malId)] = true;
    else delete map[String(anime.malId)];
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(map));
    } catch {
      /* storage full/blocked — the session state still flips */
    }
    setTracked(on);

    // server half: the ANN news sweep needs (endpoint, anime) pairs globally
    if (!pushSupported()) {
      if (on) setNote("Tracked on this device — news alerts need notifications (add the app to your Home Screen on iOS).");
      else setNote(null);
      return;
    }
    try {
      let sub = await getPushSubscriptionJson();
      if (on && !sub) {
        const r = await enablePush();
        if (r.ok) sub = await getPushSubscriptionJson();
        else setNote(r.reason === "denied" ? "Tracked on this device — allow notifications in your browser to also get ANN news alerts." : "Tracked on this device — notifications are unavailable here.");
      }
      if (sub) {
        // POST /api/ann-track/subs — the server half lives there; the lookup
        // route (/api/ann-track) is GET-only and used to 405 this silently,
        // so the tracking switch never actually reached the server
        const res = await fetch("/api/ann-track/subs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: sub.endpoint,
            keys: sub.keys,
            on,
            ann: { malId: anime.malId, annId: match?.annId ?? null, annName: match?.name ?? anime.title, title: anime.titleEnglish || anime.title, image: anime.image },
          }),
        });
        if (on && res.ok) setNote("Tracking — you'll get a notification when ANN publishes news about this anime.");
        else if (!on) setNote(null);
      }
    } catch {
      /* local tracking already saved — the server sync is best-effort */
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={onToggleOpen}
        aria-label="Track this anime via AnimeNewsNetwork"
        aria-pressed={tracked}
        className={`block w-10 h-10 rounded-full overflow-hidden bg-black/45 backdrop-blur-sm border border-white/15 active:scale-95 transition shadow-lg ${
          tracked ? "ring-2 ring-[#35d5bf] ring-offset-2 ring-offset-black/60" : ""
        }`}
      >
        {/* owner-supplied artwork: climbing the chart = tracking progress */}
        <img src="/ann-track.png" alt="" draggable={false} className="w-full h-full object-cover" />
      </button>

      {open ? (
        <div className="absolute right-0 top-12 w-[292px] max-w-[calc(100vw-24px)] rounded-2xl bg-[#141414] border border-white/10 shadow-2xl p-3.5 z-40">
          <div className="flex items-center justify-between gap-2 mb-2">
            <p className="text-[12.5px] font-bold text-white">ANN Tracking</p>
            <button onClick={() => setOpen(false)} aria-label="Close" className="w-6 h-6 rounded-full bg-[#1f1f1f] border border-white/10 flex items-center justify-center hover:bg-[#282828] transition">
              <X className="w-3.5 h-3.5 text-gray-400" />
            </button>
          </div>

          {phase === "loading" ? (
            <p className="flex items-center gap-2 text-[12px] text-gray-400 py-3">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking AnimeNewsNetwork…
            </p>
          ) : null}

          {phase === "none" ? (
            <p className="text-[12px] text-gray-400 py-3 leading-snug">
              Couldn&apos;t find <span className="text-gray-200 font-semibold">{anime.title}</span> on ANN right now — try again in a moment.
            </p>
          ) : null}

          {phase === "found" && match ? (
            <div className="py-0.5">
              <p className="text-[13px] font-bold text-gray-100 leading-snug">{match.name}</p>
              <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                {match.type ? (
                  <span className="text-[10.5px] font-bold text-gray-300 bg-[#1f1f1f] border border-white/10 rounded-full px-2 py-0.5">{match.type}</span>
                ) : null}
                {anime.airing ? (
                  <span className="text-[10.5px] font-bold text-gray-200 bg-white/5 border border-white/10 rounded-full px-2 py-0.5">Airing</span>
                ) : null}
                {tracked ? (
                  <span className="text-[10.5px] font-bold text-[#35d5bf] bg-[#35d5bf]/10 border border-[#35d5bf]/30 rounded-full px-2 py-0.5">Tracking</span>
                ) : null}
              </div>
              {match.vintage ? (
                <p className="mt-2 text-[11.5px] text-gray-400 leading-snug">
                  <span className="text-gray-300 font-semibold">Aired:</span> {match.vintage}
                </p>
              ) : null}
              {match.episodesListed ? (
                <p className="mt-1 text-[11.5px] text-gray-400 leading-snug">
                  <span className="text-gray-300 font-semibold">Episodes on ANN:</span>{" "}
                  {match.totalEps ? `${match.episodesListed} listed · ${match.totalEps} total` : match.episodesListed}
                </p>
              ) : null}
              <a
                href={match.url}
                target="_blank"
                rel="noreferrer"
                className="mt-2.5 inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-gray-300 hover:text-white transition"
              >
                <ExternalLink className="w-3.5 h-3.5" /> View on AnimeNewsNetwork
              </a>
            </div>
          ) : null}

          <div className="mt-3 pt-3 border-t border-white/10 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[12.5px] font-bold text-gray-200">Track this anime</p>
              <p className="text-[10.5px] text-gray-500 leading-snug">ANN news alerts on this device</p>
            </div>
            <Switch checked={tracked} onCheckedChange={(v) => void toggleTracked(v)} />
          </div>
          {note ? <p className="mt-2 text-[10.5px] text-gray-400 leading-snug">{note}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
