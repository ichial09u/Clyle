"use client";

/**
 * The stranded-viewer banner — the loud, un-missable version of the Profile
 * "Move to the main site" card. Shows on every mirror deployment (any origin
 * that is not TRANSFER_TARGET, so future mirrors are covered automatically):
 *  - anonymous viewers: one tap hands this device's Continue Watching and
 *    My List to the main site via the ?migrate= handoff (lib/transfer.ts)
 *  - signed-in viewers: a plain link — their account already follows them
 *    to any deployment, so moving is just opening the main URL
 * Dismiss ("Not now") hides it for this origin forever via localStorage.
 * Never rendered on the main site itself; page.tsx hides it in the player
 * and while the transfer-result toast is up.
 */

import { useEffect, useState } from "react";
import { MoveRight, X } from "lucide-react";
import { fetchSession } from "@/components/account/AccountSync";
import { getUserId } from "@/lib/profile-store";
import { getMyListMalIds } from "@/lib/client-store";
import { buildTransferUrl, isTransferTarget, TRANSFER_TARGET } from "@/lib/transfer";

const DISMISS_KEY = "clyle-move-banner-hidden";

export default function MirrorMoveBanner({ active }: { active: boolean }) {
  const [state, setState] = useState<"hidden" | "anon" | "signedin">("hidden");

  useEffect(() => {
    if (isTransferTarget()) return; // main site — nothing to move
    try {
      if (window.localStorage.getItem(DISMISS_KEY) === "1") return;
    } catch {
      /* private mode — show anyway */
    }
    let alive = true;
    fetchSession().then((s) => {
      if (!alive) return;
      setState(s.user ? "signedin" : "anon");
    });
    return () => {
      alive = false;
    };
  }, []);

  const dismiss = () => {
    setState("hidden");
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
  };

  if (!active || state === "hidden") return null;

  return (
    <div className="fixed bottom-20 lg:bottom-6 left-1/2 -translate-x-1/2 z-40 w-[min(92%,430px)] rounded-2xl border border-[#d32f2f]/40 bg-gradient-to-b from-[#1e1e1e] to-[#111111] p-4 shadow-2xl">
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className="absolute right-2.5 top-2.5 rounded-full p-1 text-gray-500 transition hover:bg-white/5 hover:text-gray-300"
      >
        <X className="w-4 h-4" />
      </button>
      <p className="pr-6 text-[13.5px] font-bold text-gray-100">We moved to a new, faster Clyle</p>
      {state === "anon" ? (
        <>
          <p className="mt-1 pr-4 text-[12px] leading-relaxed text-gray-400">
            One tap brings your Continue Watching and My List to the main site — no account
            needed, nothing is deleted here.
          </p>
          <button
            onClick={() => {
              window.location.href = buildTransferUrl(getUserId(), getMyListMalIds());
            }}
            className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg bg-[#d32f2f] px-4 text-[13px] font-semibold text-white transition hover:bg-[#b71c1c] active:scale-[0.98]"
          >
            <MoveRight className="w-4 h-4" />
            Move my progress
          </button>
        </>
      ) : (
        <>
          <p className="mt-1 pr-4 text-[12px] leading-relaxed text-gray-400">
            Clyle now lives on the main site — your account follows you there automatically.
          </p>
          <a
            href={TRANSFER_TARGET}
            className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg bg-[#d32f2f] px-4 text-[13px] font-semibold text-white transition hover:bg-[#b71c1c] active:scale-[0.98]"
          >
            <MoveRight className="w-4 h-4" />
            Open the main site
          </a>
        </>
      )}
    </div>
  );
}
