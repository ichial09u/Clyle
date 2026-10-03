"use client";

import { useEffect, useState } from "react";
import { Bell, BellRing } from "lucide-react";
import type { AnimeLite } from "@/lib/types";
import { enablePush, getPushEndpoint, pushSupported } from "@/lib/push-client";

/**
 * "Notify me about the NEXT episode of THIS anime only" — the bell on the
 * details page of any airing anime.
 *
 * Tapping it opts THIS DEVICE into that anime's drops (an AnimeNotify row on
 * the server): the moment a sync sweep imports its next episode — or the
 * daily cron sees it airing within 24h — the push goes to you and to nobody
 * who didn't ask for this show. Tapping again cancels. If push is still off,
 * the first tap asks for permission and subscribes the browser first.
 */
export default function NotifyNextToggle({ anime }: { anime: AnimeLite }) {
  const [state, setState] = useState<"loading" | "off" | "on">("loading");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // reflect the server truth for this device (a second tab may have toggled it)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const endpoint = await getPushEndpoint();
      if (!endpoint) {
        if (!cancelled) setState("off");
        return;
      }
      try {
        const res = await fetch(`/api/anime-notify?endpoint=${encodeURIComponent(endpoint)}`);
        const data = (await res.json()) as { malIds?: number[] };
        if (!cancelled) setState((data.malIds ?? []).includes(anime.malId) ? "on" : "off");
      } catch {
        if (!cancelled) setState("off");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [anime.malId]);

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      if (!pushSupported()) {
        setNote("Background notifications aren't available here (iOS needs the app added to the Home Screen first).");
        return;
      }
      let endpoint = await getPushEndpoint();
      if (!endpoint) {
        const r = await enablePush();
        if (!r.ok) {
          setNote(
            r.reason === "denied"
              ? "Notifications were blocked — allow them for this site in your browser settings."
              : "Couldn't turn notifications on — try again in a moment.",
          );
          return;
        }
        endpoint = await getPushEndpoint();
      }
      if (!endpoint) return;

      const on = state !== "on";
      const res = await fetch("/api/anime-notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint,
          malId: anime.malId,
          title: anime.titleEnglish || anime.title,
          image: anime.image,
          on,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setState(on ? "on" : "off");
      setNote(on ? "You'll be notified the moment the next episode drops." : "Removed — no more pings for this anime.");
    } catch {
      setNote("Something went wrong — try again in a moment.");
    } finally {
      setBusy(false);
    }
  };

  if (state === "loading" || !anime.airing) return null;

  const on = state === "on";
  return (
    <div className="mt-3">
      <button
        onClick={toggle}
        disabled={busy}
        aria-pressed={on}
        className={`w-full flex items-center justify-center gap-2 rounded-md text-[14px] font-bold py-2.5 transition active:scale-[0.98] disabled:opacity-60 ${
          on ? "bg-[#1f1f1f] text-gray-200 border border-white/15" : "text-white"
        }`}
        style={on ? undefined : { background: "var(--app-accent, #d32f2f)" }}
      >
        {on ? <BellRing className="w-4 h-4" style={{ color: "var(--app-accent, #d32f2f)" }} /> : <Bell className="w-4 h-4" />}
        {on ? "Notifying — next episode only" : "Notify me about the next episode"}
      </button>
      {note ? <p className="mt-1.5 text-[11.5px] text-gray-400 leading-snug">{note}</p> : null}
    </div>
  );
}
