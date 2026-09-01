import { db } from "@/lib/db";
import { skipCoverage, prefetchSkipTimes } from "@/lib/skip-times";

/**
 * Catalog-wide Skip Intro audit — the "bot walks every anime" check.
 *
 * For EVERY in-catalog anime it samples a few episodes (first / middle /
 * latest) and verifies a Skip Intro button will actually appear when the
 * opening plays:
 *
 *   exact      — the vendored AniSkip dataset has this exact episode
 *   consensus  — openings are the same video across episodes, so the
 *                anime's median interval applies
 *   live       — the live AniSkip tier has it (cached from a probe or an
 *                earlier open)
 *   heuristic  — no data, but it's a TV-length episode (5-30 min per MAL),
 *                so the player's 8-90s window guarantees the button
 *   crowd      — viewers' scrub medians taught the app where the OP ends
 *   na         — non-TV content (movies, music, ONA/OVA/specials): no Skip
 *                Intro by design (never blindly skip outside TV-length) —
 *                neither ok nor uncovered, so imports can't fail the audit
 *   uncovered  — nothing covers it and it SHOULD have a button
 *
 * `probe: true` additionally asks AniSkip live for up to `probeBudget`
 * uncovered samples (and caches the answers), which heals gaps in place —
 * this is also how "a new episode gets its skip intro imported" is
 * verified end-to-end by the 24/7 bot.
 */

export interface SkipAuditEpisode {
  ep: number;
  source: "exact" | "consensus" | "live" | "crowd" | "heuristic" | "na" | "uncovered";
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
    exact: number;
    consensus: number;
    live: number;
    crowd: number;
    heuristic: number;
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

  const totals = { anime: animes.length, sampled: 0, exact: 0, consensus: 0, live: 0, crowd: 0, heuristic: 0, na: 0, uncovered: 0 };
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
        source = cov.source;
      } else if (
        // the player's last-resort window: any TV-length episode shows the
        // button. Unknown metadata counts as TV here — the catalog's TV
        // shows are seeded from Zoko's catalog; movies always carry a type.
        (a.type === "TV" || a.type == null) &&
        (a.durationMin == null || (a.durationMin >= 5 && a.durationMin <= 30))
      ) {
        source = "heuristic";
        introEnd = 90;
      } else if (
        // non-TV content (movies, music videos, ONA/OVA/special episodes):
        // Skip Intro intentionally never shows there — the 8-90s guess is
        // far likelier wrong than right, and most shorts have no standard
        // OP at all. Count as not-applicable so imports can't fail the audit.
        (a.type != null && a.type !== "TV")
      ) {
        source = "na";
      } else {
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
