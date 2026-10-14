"use client";

/**
 * One-tap progress transfer between deployments (the "stranded anonymous
 * history" fix, part two).
 *
 * Anonymous viewers keep their watch history under a device UUID that lives
 * in per-origin localStorage — browser security makes that invisible to any
 * other origin, so the history felt lost when the site URL changed. It never
 * was: the server DB still holds every row, keyed by that UUID. The only
 * missing piece was a way for the OLD origin to hand its UUID to the NEW one.
 *
 * The handoff:
 *   1. On a mirror site (Profile → "Move my progress") the app builds
 *      TRANSFER_TARGET/?migrate=<thisDeviceId>&ml=<favoriteIds>
 *      and navigates there — the URL is the only channel that legally
 *      crosses the origin boundary.
 *   2. The target site sees ?migrate=, copies every WatchProgress row from
 *      that id onto THIS device's identity (copyProgressRows — the same
 *      machinery as the Google sign-in merge, newer-wins server-side), and
 *      rebuilds the My List favorites by malId.
 *
 * Fully idempotent: rows copy with their timestamps (existing newer rows
 * win), favorites merge deduped, and re-running the handoff is harmless.
 */

import { copyProgressRows } from "@/lib/account";
import { getUserId } from "@/lib/profile-store";
import { mergeMyListEntries } from "@/lib/client-store";

/** The main deployment every mirror hands off to. */
export const TRANSFER_TARGET = "https://clyle-src.vercel.app";

/** True when this browser is already ON the main site (nothing to move). */
export function isTransferTarget(): boolean {
  if (typeof window === "undefined") return true;
  return window.location.origin === TRANSFER_TARGET;
}

/** The handoff URL a mirror site navigates to. */
export function buildTransferUrl(fromId: string, myListIds: number[]): string {
  const sp = new URLSearchParams();
  sp.set("migrate", fromId);
  if (myListIds.length) sp.set("ml", myListIds.slice(0, 150).join(","));
  return `${TRANSFER_TARGET}/?${sp.toString()}`;
}

export interface TransferResult {
  /** rows copied onto this device's identity */
  copied: number;
  /** rows the old identity had in total (copied < total = partial network failure) */
  total: number;
  /** favorites rebuilt into My List */
  favorites: number;
}

/** Old identities are UUIDs, "google:<sub>" or the "u-..." fallback — nothing
 *  else should ever reach the copy path. */
export function transferIdOk(id: string | null): boolean {
  return !!id && /^[A-Za-z0-9:_-]{8,64}$/.test(id);
}

/**
 * Run the incoming side of the handoff. Favorites re-enter My List with
 * fresh titles/art fetched from the target's own catalog (fast DetailCache
 * path); ids that fail are skipped, never guessed.
 */
export async function runIncomingTransfer(
  fromId: string,
  favoriteIds: number[],
): Promise<TransferResult> {
  const toId = getUserId();
  if (fromId === toId) return { copied: 0, total: 0, favorites: 0 };

  const { copied, total } = await copyProgressRows(fromId, toId);

  let favorites = 0;
  if (favoriteIds.length) {
    const found = await Promise.all(
      favoriteIds.map(async (malId) => {
        try {
          const res = await fetch(`/api/anime/${malId}`, { cache: "no-store" });
          if (!res.ok) return null;
          const data = (await res.json()) as {
            anime?: { malId: number; title: string; image: string | null };
          };
          const a = data.anime;
          return a ? { malId: a.malId, title: a.title, image: a.image } : null;
        } catch {
          return null;
        }
      }),
    );
    favorites = mergeMyListEntries(
      found.filter((e): e is NonNullable<typeof e> => e !== null),
    );
  }

  return { copied, total, favorites };
}
