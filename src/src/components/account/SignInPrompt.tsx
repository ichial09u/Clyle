"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * SignInPrompt — the "you're not signed in" nudge.
 *
 * Fires ONLY when signing in would actually mean something: the viewer is
 * anonymous AND already has Continue-Watching progress that only lives on
 * this device. Rules that keep it polite:
 *   • never while signed in
 *   • never on the player screen or /signin (don't interrupt the movie)
 *   • "Not now" silences it for 3 days; "Don't ask again" forever
 *   • once per page load, one fetch to decide
 */
const DISMISS_KEY = "animetest123.prompt.dismissedAt";
const NEVER_KEY = "animetest123.prompt.never";
const RESHOW_MS = 3 * 24 * 3600 * 1000; // 3 days

export default function SignInPrompt() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let alive = true;

    try {
      if (window.localStorage.getItem(NEVER_KEY) === "1") return;
      const dismissedAt = Number(window.localStorage.getItem(DISMISS_KEY) ?? 0);
      if (dismissedAt && Date.now() - dismissedAt < RESHOW_MS) return;
      // polite on the player itself: never mid-episode
      if (window.location.pathname.startsWith("/watch") || window.location.pathname.startsWith("/signin")) return;
    } catch {
      return; // storage blocked — never nag
    }

    // small delay: let the screen settle before asking anything
    const t = setTimeout(async () => {
      try {
        const me = await fetch("/api/auth/me", { cache: "no-store" }).then((r) => r.json());
        if (!alive) return;
        if (!me?.configured || me?.user) return; // not configured, or already signed in

        // only nudge once there is something worth protecting
        const userIdRaw = window.localStorage.getItem("animetest123.user");
        const userId = userIdRaw ? (JSON.parse(userIdRaw) as { id: string }).id : null;
        if (!userId) return;
        const cont = await fetch(`/api/continue?userId=${encodeURIComponent(userId)}`, { cache: "no-store" })
          .then((r) => r.json())
          .catch(() => null);
        if (!alive) return;
        if ((cont?.items?.length ?? 0) >= 1) setShow(true);
      } catch {
        /* offline — another day */
      }
    }, 4_000);

    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, []);

  const dismiss = useCallback((forever: boolean) => {
    try {
      window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
      if (forever) window.localStorage.setItem(NEVER_KEY, "1");
    } catch {
      /* storage blocked */
    }
    setShow(false);
  }, []);

  if (!show) return null;

  return (
    <div
      role="dialog"
      aria-label="Sign in to save your progress"
      className="fixed inset-x-3 bottom-3 z-[90] mx-auto max-w-md rounded-xl border border-white/10 bg-[#111318]/95 p-4 shadow-2xl backdrop-blur md:inset-x-auto md:left-1/2 md:-translate-x-1/2"
    >
      <div className="flex items-start gap-3">
        <svg viewBox="0 0 24 24" className="mt-0.5 h-6 w-6 shrink-0" aria-hidden>
          <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.26-2.09 3.57-5.16 3.57-8.81Z" />
          <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.87-3c-1.07.72-2.44 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.29v3.1A12 12 0 0 0 12 24Z" />
          <path fill="#FBBC05" d="M5.27 14.28A7.2 7.2 0 0 1 4.89 12c0-.79.14-1.56.38-2.28v-3.1H1.29a12 12 0 0 0 0 10.76l3.98-3.1Z" />
          <path fill="#EA4335" d="M12 4.76c1.76 0 3.34.6 4.58 1.8l3.44-3.44A11.98 11.98 0 0 0 12 0 12 12 0 0 0 1.29 6.62l3.98 3.1C6.22 6.87 8.87 4.76 12 4.76Z" />
        </svg>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold leading-snug">Keep your progress on every device</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-gray-400">
            You&apos;re watching anonymously — sign in with Google and your Continue Watching follows
            you anywhere.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <a
              href="/signin"
              className="flex h-9 items-center rounded-lg bg-white px-4 text-[13px] font-semibold text-gray-900 transition hover:bg-gray-100 active:scale-[0.98]"
            >
              Sign in with Google
            </a>
            <button
              onClick={() => dismiss(false)}
              className="h-9 rounded-lg px-3 text-[13px] font-medium text-gray-400 transition hover:text-gray-200"
            >
              Not now
            </button>
            <button
              onClick={() => dismiss(true)}
              className="h-9 rounded-lg px-2 text-[12px] text-gray-600 transition hover:text-gray-400"
            >
              Don&apos;t ask again
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
