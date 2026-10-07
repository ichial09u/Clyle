"use client";

import { useEffect, useRef, useState } from "react";
import { syncAccountOnSignIn, restoreAccountOnSignOut } from "@/lib/account";
import { readProfile } from "@/lib/profile-store";

/**
 * Session watcher — mounted once in the shell.
 *
 * Polls /api/auth/me on mount + whenever the tab becomes visible again, and
 * keeps the ACTIVE local profile record in lock-step with the signed-in
 * session:
 *   • signed in  -> syncAccountOnSignIn (merge anonymous rows, flip identity)
 *   • signed out -> restoreAccountOnSignOut (device returns to its anon id)
 *
 * It deliberately does NOT render anything — the Profile screen owns the
 * account card UI. A separate component (SignInPrompt) owns the "you're not
 * signed in" nudge.
 */
export default function AccountSync() {
  const inFlight = useRef(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted) return;
    let lastUserId: string | null | undefined = undefined;

    const check = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store" });
        const data = (await res.json()) as {
          configured: boolean;
          user: { id: string; nickname: string; avatar: string | null } | null;
        };
        const user = data.configured ? data.user : null;
        const activeId = readProfile()?.id ?? null;
        if (user && user.id !== activeId) {
          await syncAccountOnSignIn(user);
          return; // syncAccountOnSignIn reloads the page
        }
        if (!user && activeId?.startsWith("google:")) {
          restoreAccountOnSignOut();
        }
        lastUserId = user?.id ?? null;
      } catch {
        /* offline — check again on next visibility/mount */
      } finally {
        inFlight.current = false;
      }
    };

    void check();
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [mounted]);

  return null;
}

/** Exposed for the Profile screen / SignInPrompt: the current session user. */
export function fetchSession(): Promise<{
  configured: boolean;
  user: { id: string; nickname: string; avatar: string | null; email?: string | null } | null;
}> {
  return fetch("/api/auth/me", { cache: "no-store" })
    .then((r) => r.json())
    .catch(() => ({ configured: false, user: null }));
}
