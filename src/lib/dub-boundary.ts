/**
 * Per-EPISODE dub boundaries — the Elbaph fix.
 *
 * The anime-level verdicts (hasDub / hasDubKiwi / hasDubMega, probed at ep 1)
 * can't express "the dub hasn't arrived in the current arc yet": One Piece
 * shows DUB buttons on every episode while the newest ~dozens have no dub at
 * all. This module maintains a PREFIX BOUNDARY per server chain:
 *
 *   dubThruS1 — highest episode with a REAL dub on the Server #1 chain
 *               (zoko -> kiwi -> supaplay -> megaplay); 0 = proven none
 *   dubThruS2 — same for the Server #2 chain (kiwi -> zoko -> megaplay)
 *   dubHiS1/2 — highest episode PROVEN dub-less (binary-search hi bound)
 *
 * A probe "clicks the DUB server" exactly like the player does: it runs the
 * real resolution chain, including the fake-dub segment verification, so a
 * miss is proof the dub isn't there — never a sub-detection error.
 *
 * Boundaries move monotonically (thru only advances on a positive probe, hi
 * only drops on a negative one), which makes the search resumable and safe
 * to spread across the fleet bots AND the runtime. The UI treats null
 * (unprobed) as "unknown — keep the optimistic anime-level behaviour".
 *
 * Server-side only.
 */

import { db } from "@/lib/db";
import { verifyRealDub } from "@/lib/zoko-stream";
import { verifyRealMegaplayDub } from "@/lib/megaplay";
import { supaplayDub } from "@/lib/supaplay";
import type { ServerId } from "@/lib/zoko";

export type DubChain = "s1" | "s2";

const CHAINS: DubChain[] = ["s1", "s2"];

export interface DubThrough {
  s1: number | null;
  s2: number | null;
}

/* ------------------------------------------------------------------ *
 * Probe one episode on one chain — every source the DUB button would
 * try, in the same order the stream route falls back through.
 *   true  = at least one source serves a REAL dub for this episode
 *   false = every source DEFINITIVELY lacks one (page 404 / fake dub /
 *           ad-stub playlist) — the Elbaph-arc answer
 *   null  = some source couldn't be reached — no verdict, retry later
 * ------------------------------------------------------------------ */
export async function probeDubChainEp(malId: number, ep: number, chain: DubChain): Promise<boolean | null> {
  const servers: ServerId[] = chain === "s1" ? ["zoko", "kiwi"] : ["kiwi", "zoko"];
  let sawTransient = false;
  for (const s of servers) {
    const v = await verifyRealDub(malId, ep, s).catch(() => null);
    if (v === true) return true;
    if (v === null) sawTransient = true;
  }
  // SupaPlay is Server #1's first backfill (mapped anime only — null just
  // means unmapped/fetch-failed; megaplay below is the final backfill anyway)
  if (chain === "s1") {
    try {
      const a = await db.anime.findUnique({ where: { malId }, select: { supaplayPath: true } });
      if (a?.supaplayPath?.trim()) {
        const supa = await supaplayDub(malId, ep).catch(() => null);
        if (supa) return true;
      }
    } catch {
      /* backfill probe is best-effort */
    }
  }
  const mega = await verifyRealMegaplayDub(malId, ep).catch(() => null);
  if (mega === true) return true;
  if (mega === null || sawTransient) return null; // can't prove absence on a hiccup
  return false;
}

/* ------------------------------------------------------------------ *
 * Monotonic boundary updates. Every definitive probe is persisted in
 * DubProbe (ground truth + diagnostics) and folds into the boundary:
 *   ok  @ ep -> thru = max(thru, ep)        (dub proven through ep)
 *   miss @ ep -> hi  = min(hi, ep)          (dub proven absent at ep)
 * ------------------------------------------------------------------ */
export async function recordProbeResult(
  malId: number,
  ep: number,
  chain: DubChain,
  ok: boolean,
  provider?: string | null,
  detail?: string | null,
): Promise<void> {
  await db.dubProbe.upsert({
    where: { malId_ep_chain: { malId, ep, chain } },
    create: { malId, ep, chain, ok, provider: provider ?? null, detail: detail ?? null },
    update: { ok, provider: provider ?? null, detail: detail ?? null },
  });

  const a = await db.anime.findUnique({
    where: { malId },
    select: { dubThruS1: true, dubHiS1: true, dubThruS2: true, dubHiS2: true },
  });
  if (!a) return;
  const thruKey = chain === "s1" ? "dubThruS1" : "dubThruS2";
  const hiKey = chain === "s1" ? "dubHiS1" : "dubHiS2";
  const curThru = (chain === "s1" ? a.dubThruS1 : a.dubThruS2) ?? 0;
  const curHi = (chain === "s1" ? a.dubHiS1 : a.dubHiS2) ?? null;
  const data: Record<string, number | Date | null> = { dubThruCheckedAt: new Date() };
  if (ok) {
    if (ep > curThru) data[thruKey] = ep;
    // a positive probe at/above the hi bound is stale evidence — the dub
    // caught up; lift the hi bound so future searches can move past it
    if (curHi != null && ep >= curHi) data[hiKey] = null;
  } else {
    if (curHi == null || ep < curHi) data[hiKey] = ep;
    // a negative probe INSIDE the proven prefix means the dub was pulled —
    // walk the boundary back to just below it (prefix semantics)
    if (ep <= curThru) data[thruKey] = ep - 1;
  }
  await db.anime.update({ where: { malId }, data }).catch(() => undefined);
}

/**
 * The next episode a search should probe for this chain, or null when the
 * boundary is settled.
 *
 * Strategy:
 *   thru unknown, no false proof  -> probe the LAST episode (one probe
 *                                    settles fully-dubbed seasonal shows)
 *   thru unknown, false proof set -> binary-search midpoint (lo, hi)
 *   thru known, gap open          -> probe thru+1 (advance) when it closes
 *                                    the gap, else the midpoint
 *   closed + `recheck`            -> probe thru+1 anyway: dubs catch up
 *                                    weekly (One Piece), so a stale closed
 *                                    boundary re-tests one past its edge
 */
export function nextDubProbeEp(
  a: {
    totalEpisodes: number;
    dubThruS1: number | null; dubHiS1: number | null;
    dubThruS2: number | null; dubHiS2: number | null;
  },
  chain: DubChain,
  opts: { recheck?: boolean } = {},
): number | null {
  const total = a.totalEpisodes;
  if (!total || total <= 0) return null;
  const thru = (chain === "s1" ? a.dubThruS1 : a.dubThruS2) ?? null;
  if (thru != null && thru <= 0) return null; // proven no dub anywhere — closed
  const hi = (chain === "s1" ? a.dubHiS1 : a.dubHiS2) ?? total + 1;
  const lo = thru ?? 0;
  if (thru == null) {
    if (hi >= total + 1) return total; // nothing proven false yet — probe the end
    return Math.ceil((lo + 1 + (hi - 1)) / 2); // binary search midpoint
  }
  if (lo >= hi - 1) {
    // closed — but dubs arrive over time: a stale boundary re-tests its edge
    return opts.recheck && thru < total ? Math.min(total, thru + 1) : null;
  }
  if (hi >= total + 1) return total; // gap open, no false proof — probe the end
  // open gap with proven bounds — binary-search its midpoint (a size-1 gap
  // collapses to that single episode, which doubles as the advance check)
  return Math.ceil((thru + 1 + (hi - 1)) / 2);
}

/**
 * Run the boundary search for one anime to (local) completion. Called in
 * the background by the episodes route; each definitive probe persists, so
 * an interrupted run resumes exactly where it stopped.
 */
export async function recomputeDubBoundaries(
  malId: number,
  maxProbes = 14,
  opts: { recheck?: boolean } = {},
): Promise<number> {
  const a = await db.anime.findUnique({
    where: { malId },
    select: {
      malId: true, totalEpisodes: true,
      dubThruS1: true, dubHiS1: true, dubThruS2: true, dubHiS2: true,
      hasDub: true, hasDubKiwi: true, hasDubMega: true,
    },
  });
  if (!a || !a.totalEpisodes) return 0;

  // free settlement from the existing anime-level verdicts (probed at ep 1):
  // no dub anywhere -> both chains close at 0 without a single network probe
  const freeNone = a.hasDub === false && a.hasDubKiwi === false && a.hasDubMega === false;
  // a verified ep-1 dub lifts the starting lower bound to 1
  const seedThru = a.hasDub === true || a.hasDubKiwi === true || a.hasDubMega === true ? 1 : null;
  const patches: Record<string, number> = {};
  for (const chain of CHAINS) {
    const thruKey = chain === "s1" ? "dubThruS1" : "dubThruS2";
    if (freeNone) patches[thruKey] = 0;
    else if (seedThru != null && (chain === "s1" ? a.dubThruS1 : a.dubThruS2) == null) patches[thruKey] = seedThru;
  }
  if (Object.keys(patches).length) {
    await db.anime.update({ where: { malId }, data: { ...patches, dubThruCheckedAt: new Date() } }).catch(() => undefined);
    if (freeNone) return 0;
  }

  let probes = 0;
  for (const chain of CHAINS) {
    for (;;) {
      const cur = await db.anime.findUnique({
        where: { malId },
        select: {
          totalEpisodes: true,
          dubThruS1: true, dubHiS1: true, dubThruS2: true, dubHiS2: true,
        },
      });
      if (!cur) break;
      const ep = nextDubProbeEp(cur, chain, opts);
      if (ep == null) break;
      if (probes >= maxProbes) return probes; // resume later (next visit / bot)
      const verdict = await probeDubChainEp(malId, ep, chain);
      if (verdict === null) break; // transient — retry on a later pass
      await recordProbeResult(malId, ep, chain, verdict);
      probes++;
    }
  }
  return probes;
}

/** The boundaries the UI should use (raw columns; null = unknown/optimistic). */
export function dubThroughOf(a: { dubThruS1: number | null; dubThruS2: number | null }): DubThrough {
  return { s1: a.dubThruS1 ?? null, s2: a.dubThruS2 ?? null };
}

/**
 * Should the DUB button show for episode N on this chain?
 *   thru == null -> null (unknown: caller falls back to the anime-level verdict)
 *   otherwise    -> N <= thru (0 = no dub anywhere on this chain)
 */
export function dubAvailableAtEp(thru: number | null, ep: number): boolean | null {
  if (thru == null) return null;
  return ep <= thru;
}
