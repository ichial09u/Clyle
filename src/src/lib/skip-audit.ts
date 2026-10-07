import { db } from "@/lib/db";
import { skipCoverage, prefetchSkipTimes } from "@/lib/skip-times";

/**
 * Catalog-wide Skip Intro audit — the "bot walks every anime" check.
 *
 * For EVERY in-catalog anime it samples a few episodes (first / middle /
 * latest) and verifies a Skip Intro button will actually appear when the
 * opening plays:
 *
 *   scout      — the intro-scout fleet measured this exact episode on our
 *                own stream (highest-quality data after Zoko itself)
 *   exact      — the vendored AniSkip dataset has this exact episode
 *   consensus  — openings are the same video across episodes, so the
 *                anime's median interval applies
 *   live       — the live AniSkip tier has it (cached from a probe or an
 *                earlier open)
 *   skipdb     — the SkipDB (skipdb.tv) fill table covers this anime —
 *                the fallback source for shows AniSkip doesn't carry
 *                (HxH 2011, Code Geass R2, Oshi no Ko, Naruto Shippuden…)
 *   crowd      — viewers' scrub medians taught the app where the OP ends
 *   na         — no button BY DESIGN: non-TV content (movies, music,
 *                ONA/OVA/specials), TV episodes longer than 30 min (no
 *                standard OP position — the crowd tier self-learns those),
 *                and episodes where the fleet CONFIRMED there is no
 *                opening (nodetect — the button is suppressed on purpose)
 *   uncovered  — nothing covers it and it SHOULD have a button. With the
 *                blind 8-90s heuristic gone, an uncovered episode simply
 *                shows no Skip Intro button — the fleet is the way to heal
 *                it.
 *
 * `probe: true` additionally asks AniSkip live for up to `probeBudget`
 * uncovered samples (and caches the answers), which heals gaps in place —
 * this is also how "a new episode gets its skip intro imported" is
 * verified end-to-end by the 24/7 bot.
 */

export interface SkipAuditEpisode {
  ep: number;
  source: "scout" | "exact" | "consensus" | "skipdb" | "live" | "crowd" | "na" | "uncovered";
  introEnd: number | null;
}

export interface SkipAuditRow {
  malId: number;
  title: string;
  type: string | null;
  ok: boolean;
  episodes: SkipAuditEpisode[];
}

export interface SkipAuditReport {
  ok: boolean;
  generatedAt: string;
  totals: {
    anime: number;
    sampled: number;
    scout: number;
    exact: number;
    consensus: number;
    skipdb: number;
    live: number;
    crowd: number;
    na: number;
    uncovered: number;
    coveragePct: number;
    probed: number;
  };
  anime: SkipAuditRow[];
}

export async function runSkipAudit(probe = false, probeBudget = 6): Promise<SkipAuditReport> {
  const animes = await db.anime.findMany({
    where: { inCatalog: true },
    select: { malId: true, title: true, type: true, durationMin: true, totalEpisodes: true },
    orderBy: { popularity: "asc" },
  });

  const totals = { anime: animes.length, sampled: 0, scout: 0, exact: 0, consensus: 0, skipdb: 0, live: 0, crowd: 0, na: 0, uncovered: 0 };
  const uncoveredList: Array<{ malId: number; ep: number; lenMin?: number | null }> = [];
  const rows: SkipAuditRow[] = [];

  for (const a of animes) {
    const total = Math.max(1, a.totalEpisodes || 1);
    // first / middle / latest — deduped, always >= 1
    const samples = [...new Set([1, Math.max(1, Math.floor(total / 2)), total])].map((n) => Math.min(n, total));
    const episodes: SkipAuditEpisode[] = [];
    let ok = true;

    for (const ep of samples) {
      totals.sampled++;
      const cov = await skipCoverage(a.malId, ep, { episodeLengthMin: a.durationMin });
      let source: SkipAuditEpisode["source"] = "uncovered";
      let introEnd: number | null = cov?.intro?.end ?? null;
      if (cov?.intro) {
        // an "owner" row can never carry an intro today (it means the owner
        // verified there IS no opening) — but if one ever does, count it as
        // an intentional suppression, not a data source
        source = cov.source === "owner" ? "na" : cov.source;
      } else if (cov?.confirmedNone) {
        // the fleet watched this episode (or the owner confirmed it): there
        // IS no opening — the button is suppressed on purpose, as designed
        source = "na";
      } else if (
        // non-TV content (movies, music videos, ONA/OVA/special episodes)
        // AND TV episodes longer than 30 min (PSYCHO-PASS 3, RIN — hour-long
        // formats): Skip Intro intentionally never guesses there — there is
        // no standard OP position and the crowd-scrub tier self-learns them.
        // Count as not-applicable so imports can't fail the audit.
        (a.type != null && a.type !== "TV") ||
        ((a.type === "TV" || a.type == null) && a.durationMin != null && a.durationMin > 30)
      ) {
        source = "na";
      } else {
        // no data at all — since the blind heuristic was removed this
        // episode simply shows NO Skip Intro button until the fleet or
        // AniSkip measures it
        ok = false;
        uncoveredList.push({ malId: a.malId, ep, lenMin: a.durationMin });
      }
      totals[source]++;
      episodes.push({ ep, source, introEnd });
    }
    rows.push({ malId: a.malId, title: a.title, type: a.type, ok, episodes });
  }

  // optional self-heal: ask AniSkip live about gaps and re-evaluate them
  let probed = 0;
  if (probe && uncoveredList.length) {
    probed = await prefetchSkipTimes(uncoveredList.slice(0, probeBudget), probeBudget);
    for (const row of rows) {
      for (const e of row.episodes) {
        if (e.source !== "uncovered") continue;
        const cov = await skipCoverage(row.malId, e.ep); // reads the warmed live cache
        if (cov?.intro) {
          if (cov.source === "owner") continue; // owner suppression — not coverage
          e.source = cov.source;
          e.introEnd = cov.intro.end;
          row.ok = true;
          totals.uncovered--;
          totals[cov.source]++;
        }
      }
    }
  }

  const covered = totals.sampled - totals.uncovered - totals.na;
  const audited = Math.max(1, totals.sampled - totals.na);
  return {
    ok: totals.uncovered === 0,
    generatedAt: new Date().toISOString(),
    totals: {
      ...totals,
      coveragePct: Math.round((covered / audited) * 100),
      probed,
    },
    anime: rows,
  };
}
