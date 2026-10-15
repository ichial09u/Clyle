"use client";

/**
 * One-tap progress transfer between deployments (the "stranded anonymous
 * history" fix, part two).
 *
 * Anonymous viewers keep their watch history under a device UUID that lives
 * in per-origin localStorage — browser security makes that invisible to any
 * other origin, so the history felt lost when the site URL changed. It never
 * was: the server DB holds every mirrored row, keyed by that UUID. The only
 * missing piece was a way for the OLD origin to hand its UUID to the NEW one.
 *
 * The handoff:
 *   1. On a mirror site (banner / Profile → "Move my progress") the app
 *      builds TRANSFER_TARGET/?migrate=<deviceId>&ml=<favs>&p=<progress>
 *      and navigates there — the URL is the only channel that legally
 *      crosses the origin boundary.
 *      `p` carries the device's FULL local watch history (the server copy
 *      can lag — per-instance /tmp slivers, bot merge cadence) — packed
 *      newest-first within a URL budget, so the port is complete even when
 *      the server only ever saw part of the story.
 *   2. The target site sees ?migrate=, copies every WatchProgress row from
 *      that id onto THIS device's identity (copyProgressRows — the same
 *      machinery as the Google sign-in merge, newer-wins server-side),
 *      re-mirrors the URL-carried rows onto this origin's server, writes
 *      them locally so Continue Watching shows instantly, and rebuilds My
 *      List + row titles/art by re-fetching /api/anime/{id} (fast
 *      DetailCache path).
 *
 * Fully idempotent: rows copy with their timestamps (existing newer rows
 * win), favorites merge deduped, and re-running the handoff is harmless.
 */

import { copyProgressRows } from "@/lib/account";
import { getUserId } from "@/lib/profile-store";
import {
  getAllTransferProgress,
  importTransferProgress,
  mergeMyListEntries,
  type TransferProgressRow,
} from "@/lib/client-store";

/** The main deployment every mirror hands off to. */
export const TRANSFER_TARGET = "https://clyle-src.vercel.app";

/** URL budget for the packed progress payload. Rows are sorted newest-first,
 *  so a cap trims the oldest rewatch data, never the freshest resume points. */
const MAX_PROGRESS_CHARS = 1500;
/** Cap on enriching titles/art for carried rows + favorites (DetailCache hits). */
const MAX_ENRICH_IDS = 60;

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
  const packed = encodeTransferProgress(getAllTransferProgress());
  if (packed) sp.set("p", packed);
  return `${TRANSFER_TARGET}/?${sp.toString()}`;
}

/**
 * Pack progress rows as "malId.ep.pos.dur.lang.server.completed.total.min"
 * joined by ";" — fixed field order, lang s/d, bools 0/1, seconds as ints,
 * timestamps at minute resolution (fits the URL, keeps newer-wins working).
 * Emits newest-first until the budget is spent.
 */
export function encodeTransferProgress(rows: TransferProgressRow[]): string {
  const parts: string[] = [];
  let used = 0;
  for (const r of rows) {
    const s = [
      r.malId,
      Math.max(1, r.episode),
      Math.max(0, Math.round(r.pos)),
      Math.max(0, Math.round(r.dur)),
      r.lang === "dub" ? "d" : "s",
      encodeURIComponent(r.server || "zoko"),
      r.completed ? 1 : 0,
      r.total && r.total > 0 ? Math.round(r.total) : 0,
      Math.max(0, Math.round(r.updatedAt / 60000)),
    ].join(".");
    if (used + s.length + 1 > MAX_PROGRESS_CHARS) break;
    parts.push(s);
    used += s.length + 1;
  }
  return parts.join(";");
}

/** Inverse of encodeTransferProgress — tolerant: bad rows are skipped. */
export function parseTransferProgress(raw: string | null): TransferProgressRow[] {
  if (!raw) return [];
  const out: TransferProgressRow[] = [];
  for (const part of raw.split(";")) {
    const f = part.split(".");
    if (f.length !== 9) continue;
    const malId = Number(f[0]);
    const episode = Number(f[1]);
    if (!Number.isInteger(malId) || malId <= 0) continue;
    if (!Number.isInteger(episode) || episode <= 0) continue;
    const server = decodeURIComponent(f[5]) || "zoko";
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(server)) continue;
    out.push({
      malId,
      episode,
      pos: Number(f[2]) || 0,
      dur: Number(f[3]) || 0,
      lang: f[4] === "d" ? "dub" : "sub",
      server,
      completed: f[6] === "1",
      total: Number(f[7]) > 0 ? Number(f[7]) : undefined,
      updatedAt: Number(f[8]) > 0 ? Number(f[8]) * 60000 : 0,
    });
  }
  return out.slice(0, 120);
}

export interface TransferResult {
  /** rows copied onto this device's identity (server-side copy) */
  copied: number;
  /** rows the old identity had in total (copied < total = partial network failure) */
  total: number;
  /** favorites rebuilt into My List */
  favorites: number;
  /** rows ported from the handoff URL itself (full local history) */
  carried: number;
}

/** Old identities are UUIDs, "google:<sub>" or the "u-..." fallback — nothing
 *  else should ever reach the copy path. */
export function transferIdOk(id: string | null): boolean {
  return !!id && /^[A-Za-z0-9:_-]{8,64}$/.test(id);
}

/** Titles/art for the favorites + carried rows via the fast DetailCache path. */
async function enrichMeta(malIds: number[]): Promise<Map<number, { malId: number; title: string; image: string | null }>> {
  const meta = new Map<number, { malId: number; title: string; image: string | null }>();
  const ids = Array.from(new Set(malIds)).slice(0, MAX_ENRICH_IDS);
  await Promise.all(
    ids.map(async (malId) => {
      try {
        const res = await fetch(`/api/anime/${malId}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as {
          anime?: { malId: number; title: string; image: string | null };
        };
        const a = data.anime;
        if (a) meta.set(malId, a);
      } catch {
        /* skip — rows land without art, never guessed */
      }
    }),
  );
  return meta;
}

/** POST the URL-carried rows onto this origin's server under the current
 *  identity (newer-wins server-side), small batches to stay mobile-friendly. */
async function reMirrorRows(rows: TransferProgressRow[], toId: string, meta: Map<number, { title: string; image: string | null }>): Promise<number> {
  let ok = 0;
  for (let i = 0; i < rows.length; i += 8) {
    const batch = rows.slice(i, i + 8);
    const results = await Promise.all(
      batch.map(async (r) => {
        const m = meta.get(r.malId);
        try {
          const res = await fetch("/api/progress", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userId: toId,
              malId: r.malId,
              episode: r.episode,
              lang: r.lang,
              server: r.server,
              position: r.pos,
              duration: r.dur,
              completed: r.completed,
              title: m?.title,
              image: m?.image ?? null,
              updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : undefined,
            }),
          });
          return res.ok;
        } catch {
          return false;
        }
      }),
    );
    ok += results.filter(Boolean).length;
  }
  return ok;
}

/**
 * Run the incoming side of the handoff. Favorites re-enter My List with
 * fresh titles/art; carried progress rows are re-mirrored to this origin's
 * server and written locally (newer-wins both sides).
 */
export async function runIncomingTransfer(
  fromId: string,
  favoriteIds: number[],
  progressRows: TransferProgressRow[] = [],
): Promise<TransferResult> {
  const toId = getUserId();
  if (fromId === toId) return { copied: 0, total: 0, favorites: 0, carried: 0 };

  const { copied, total } = await copyProgressRows(fromId, toId);

  const meta = await enrichMeta([...favoriteIds, ...progressRows.map((r) => r.malId)]);

  const carried = progressRows.length ? await reMirrorRows(progressRows, toId, meta) : 0;
  importTransferProgress(progressRows, meta);

  let favorites = 0;
  if (favoriteIds.length) {
    favorites = mergeMyListEntries(
      favoriteIds
        .map((malId) => meta.get(malId))
        .filter((e): e is NonNullable<typeof e> => e !== undefined),
    );
  }

  return { copied, total, favorites, carried };
}
