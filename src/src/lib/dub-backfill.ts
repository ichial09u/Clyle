/**
 * Always-on dub catch-up sweep — "when a dub arrives, the DUB server fills
 * itself in".
 *
 * The boundary search itself lives in dub-boundary.ts and the player + the
 * episode grid already consume it automatically — a show's DUB buttons and
 * streams follow dubThruS1/S2 with zero manual work. What this module adds
 * is SCHEDULED COVERAGE, so a dub is discovered even when nobody has opened
 * that show's episode grid lately (the on-view recheck needs a viewer):
 *
 *   queue 1 — AIRING shows with an open/incomplete boundary search:
 *             stalest-checked first, recheck mode. Dubs land weekly
 *             (One Piece), so a recheck probe at thru+1 flips each newly
 *             dubbed episode the moment it arrives — the catch-up engine.
 *   queue 2 — NEVER boundary-checked anime (new imports / verdict-less):
 *             most popular first. A dub that just showed up on a newer
 *             anime is discovered here; the first probe targets the LAST
 *             episode, so fully-dubbed seasonals settle in one probe.
 *
 * Every probe runs the REAL player chain (probeDubChainEp — zoko/kiwi/
 * supaplay/megaplay/anikoto with fake-dub verification), so a "yes" means
 * the DUB button actually plays. Boundaries only move on proof.
 *
 * Callers:
 *   - /api/cron   — the daily heal, ~15s budget, runs FIRST so a busy sync
 *                   can never starve it
 *   - /api/sync?kick=1 — every app open (server-throttled to one sweep per
 *                   5 min), a ~9s budget so dubs surface within minutes
 *                   of arriving, all day long
 *
 * Strictly time-budgeted: checks the deadline between anime, and caps the
 * probes per anime (maxProbes) — the search is monotonic + persisted, so
 * an interrupted sweep simply resumes on the next pass.
 */

import { db } from "@/lib/db";
import { recomputeDubBoundaries, nextDubProbeEp } from "@/lib/dub-boundary";

export interface DubSweepResult {
  /** anime whose boundary search actually ran (network probes spent) */
  checked: number;
  /** total network probes spent across all anime */
  probes: number;
  /** anime whose dub-through advanced (dub episodes newly proven) */
  advanced: number;
  /** the shows that advanced — for logs ("[dub-sweep] One Piece -> ep 1147") */
  discovered: Array<{ malId: number; title: string; thru: number }>;
  budgetMs: number;
  elapsedMs: number;
}

interface BoundaryRow {
  malId: number;
  title: string;
  titleEnglish: string | null;
  airing: boolean;
  totalEpisodes: number;
  dubThruS1: number | null;
  dubHiS1: number | null;
  dubThruS2: number | null;
  dubHiS2: number | null;
  dubThruCheckedAt: Date | null;
  popularity: number | null;
}

const BOUNDARY_SELECT = {
  malId: true,
  title: true,
  titleEnglish: true,
  airing: true,
  totalEpisodes: true,
  dubThruS1: true,
  dubHiS1: true,
  dubThruS2: true,
  dubHiS2: true,
  dubThruCheckedAt: true,
  popularity: true,
} as const;

const titleOf = (a: { title: string; titleEnglish: string | null }) =>
  a.titleEnglish?.trim() || a.title;

/**
 * Run one budgeted sweep. Returns what happened (also console.logged so
 * Vercel/Render logs surface every dub that arrived).
 */
export async function dubBackfillSweep(
  opts: { budgetMs?: number; maxCatchup?: number; maxNew?: number } = {},
): Promise<DubSweepResult> {
  const budgetMs = opts.budgetMs ?? 15_000;
  const maxCatchup = opts.maxCatchup ?? 6;
  const maxNew = opts.maxNew ?? 3;
  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;
  const res: DubSweepResult = {
    checked: 0,
    probes: 0,
    advanced: 0,
    discovered: [],
    budgetMs,
    elapsedMs: 0,
  };

  // "definitively sub-only with no backfill mapping" — the boundary search
  // can never find anything for these, keep them out of both queues
  const dubPossible = {
    NOT: {
      hasDub: false,
      hasDubKiwi: false,
      hasDubMega: false,
      supaplayPath: null,
      anikotoSeriesId: null,
    },
  } as const;

  const sweepOne = async (
    a: BoundaryRow,
    maxProbes: number,
    recheck: boolean,
  ) => {
    const before = Math.max(a.dubThruS1 ?? 0, a.dubThruS2 ?? 0);
    const probes = await recomputeDubBoundaries(a.malId, maxProbes, { recheck }).catch(() => 0);
    res.checked++;
    res.probes += probes;
    if (probes > 0) {
      const after = await db.anime
        .findUnique({ where: { malId: a.malId }, select: { dubThruS1: true, dubThruS2: true } })
        .catch(() => null);
      const thru = after ? Math.max(after.dubThruS1 ?? 0, after.dubThruS2 ?? 0) : before;
      if (thru > before) {
        res.advanced++;
        if (res.discovered.length < 12) {
          res.discovered.push({ malId: a.malId, title: titleOf(a), thru });
          console.log(`[dub-sweep] ${titleOf(a)} (#${a.malId}) dub now through ep ${thru} (was ${before})`);
        }
      }
    }
  };

  // ---- queue 1: airing shows — weekly dub catch-up ---------------------
  // stalest boundary-check first; SQLite ASC already puts NULL (never
  // checked) at the front. Bounded over-fetch (40) because proven-pulled
  // shows (thru=0) are filtered for free below but keep a stale timestamp.
  try {
    const airing = await db.anime.findMany({
      where: { inCatalog: true, airing: true, totalEpisodes: { gt: 0 }, ...dubPossible },
      select: BOUNDARY_SELECT,
      orderBy: { dubThruCheckedAt: "asc" },
      take: 40,
    });
    for (const a of airing) {
      if (res.checked >= maxCatchup || Date.now() >= deadline) break;
      // free skip for settled boundaries (thru=0 pulled / fully caught up
      // with no recheck needed this pass) — zero network cost
      const open =
        nextDubProbeEp(a, "s1", { recheck: true }) != null ||
        nextDubProbeEp(a, "s2", { recheck: true }) != null;
      if (!open) continue;
      await sweepOne(a, 4, true);
    }
  } catch (err) {
    console.error("[dub-sweep] catch-up queue failed:", String(err).slice(0, 160));
  }

  // ---- queue 2: never boundary-checked — new-anime dub discovery -------
  // most popular first (MAL popularity ASC), any airing state: a dub that
  // lands on a finished seasonal counts too
  try {
    const fresh = await db.anime.findMany({
      where: { inCatalog: true, totalEpisodes: { gt: 0 }, dubThruCheckedAt: null, ...dubPossible },
      select: BOUNDARY_SELECT,
      orderBy: { popularity: "asc" },
      take: maxNew,
    });
    for (const a of fresh) {
      if (Date.now() >= deadline) break;
      await sweepOne(a, 4, false);
    }
  } catch (err) {
    console.error("[dub-sweep] discovery queue failed:", String(err).slice(0, 160));
  }

  res.elapsedMs = Date.now() - startedAt;
  return res;
}
