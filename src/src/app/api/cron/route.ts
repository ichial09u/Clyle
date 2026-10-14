import { NextResponse, after } from "next/server";
import { db } from "@/lib/db";
import { syncCatalog, lastSync } from "@/lib/sync";
import { prefetchSkipTimes } from "@/lib/skip-times";
import { runSkipAudit } from "@/lib/skip-audit";
import { refreshTop10Month } from "@/lib/top10-month";
import { refreshArriving } from "@/lib/arriving";
import { notifyAiringSoon } from "@/lib/push";
import { dubBackfillSweep } from "@/lib/dub-backfill";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/cron — scheduled self-test + self-heal entry point.
 *
 * Vercel Cron hits this on a schedule (see vercel.json). The SHAPE of the
 * run is split by latency:
 *
 *   - INLINE (fast, DB-only): reachability, catalog counts, comment-tree
 *     sanity, user-data counts, fleet status — these answer instantly and
 *     the report returns well inside the 60s lambda cap.
 *
 *   - BACKGROUND (after(), network-heavy): the catalog sync sweep (+ skip
 *     prefetch + "airing soon" pushes), the skip-intro audit's live probes,
 *     and the Anime Trending chart refresh. A previous layout awaited all of
 *     that inline and the lambda began to bust its 60s budget on cold starts
 *     (FUNCTION_INVOCATION_TIMEOUT) — the heals are idempotent, so running
 *     them after the response is strictly better: cron gets its 200, the
 *     work still happens, and the next run reports the results (SyncLog).
 *
 * This is the server half of the "bot that play-tests everything": the client
 * half is `scripts/e2e-smoke.mjs` (`npm run smoke`), which exercises the real
 * HTTP surface. Together they catch and auto-fix the known failure classes,
 * and produce actionable reports for anything that needs a human.
 */
export async function GET(req: Request) {
  const startedAt = new Date().toISOString();
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const fixes: string[] = [];
  let healthy = true;

  // ---- 1) database reachable ----
  let animeCount = -1;
  let episodeCount = -1;
  try {
    animeCount = await db.anime.count({ where: { inCatalog: true } });
    episodeCount = await db.episode.count();
    checks.push({ name: "database", ok: true, detail: `${animeCount} anime / ${episodeCount} episodes` });
  } catch (err) {
    healthy = false;
    checks.push({ name: "database", ok: false, detail: String(err) });
    return NextResponse.json(
      { ok: false, startedAt, checks, fixes, note: "database unreachable — nothing to heal" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }

  // ---- 2) catalog integrity ----
  if (animeCount <= 0) {
    healthy = false;
    checks.push({ name: "catalog", ok: false, detail: "catalog is EMPTY" });
  } else {
    checks.push({ name: "catalog", ok: true, detail: `${animeCount} in-catalog anime` });
  }

  // ---- 3) background heals — network-heavy, run AFTER the response ----
  after(async () => {
    // 3a) dub catch-up sweep — "when a dub arrives it auto-fills the dub
    //     servers": stalest-first recheck probes advance the per-episode
    //     boundaries (dubThruS1/S2) and DUB buttons/streams follow with
    //     zero manual work. Runs FIRST so a busy catalog sync can never
    //     starve it — it is the only scheduled pass the dub feature gets.
    try {
      const sweep = await dubBackfillSweep({ budgetMs: 15_000, maxCatchup: 6, maxNew: 3 });
      if (sweep.checked > 0) {
        console.log(
          `[cron] dub sweep: checked ${sweep.checked} anime / ${sweep.probes} probes / ${sweep.advanced} advanced in ${sweep.elapsedMs}ms`,
        );
        fixes.push(`dub sweep: ${sweep.advanced} anime caught up (checked ${sweep.checked})`);
      }
    } catch (err) {
      console.error("[cron] dub sweep failed:", String(err).slice(0, 200));
    }

    // 3b) catalog drift -> auto re-sync (heal): new episodes + new anime,
    //     skip-time prefetch for imports, and "drops in ~N hours" reminders
    try {
      const syncResult = await syncCatalog();
      if (syncResult.episodesAdded > 0 || syncResult.animeAdded > 0) {
        fixes.push(`catalog sync imported ${syncResult.episodesAdded} episodes / ${syncResult.animeAdded} anime`);
        console.log("[cron] heal: sync imported", syncResult.episodesAdded, "episodes /", syncResult.animeAdded, "anime");
      }
      if (syncResult.newEpisodes.length) await prefetchSkipTimes(syncResult.newEpisodes).catch(() => undefined);
      await notifyAiringSoon().catch(() => undefined);
    } catch (err) {
      // upstream (Jikan/AniList) failures are not fatal for the app
      console.error("[cron] catalog-sync heal failed:", String(err).slice(0, 200));
    }

    // 3c) skip intro audit — verifies a Skip Intro button will appear
    //     (scout / exact / consensus / live tiers); `probe` asks AniSkip
    //     live and heals gaps in place
    try {
      const audit = await runSkipAudit(true, 5);
      const t = audit.totals;
      console.log(
        `[cron] skip-intro audit: ${t.coveragePct}% of ${t.sampled} sampled episodes show Skip Intro (${t.scout} scout / ${t.exact} exact / ${t.consensus} consensus / ${t.live} live / ${t.crowd} crowd / ${t.na} na / ${t.uncovered} uncovered, probed ${t.probed})`,
      );
      if (!audit.ok) {
        const bad = audit.anime.filter((a) => !a.ok).slice(0, 5).map((a) => `${a.title} (${a.episodes.filter((e) => e.source === "uncovered").map((e) => `ep${e.ep}`).join(",")})`);
        console.error("[cron] skip intro still uncovered after probing:", bad.join("; "));
      }
    } catch (err) {
      console.error("[cron] skip-intro-audit failed:", String(err).slice(0, 200));
    }

    // 3d) Top 10 rank notifications (bell + push data path) — TTL-gated
    //     inside refreshTop10Month; plus the Arriving rail snapshot (same
    //     discipline: the route after()s the refresh too, cron keeps it warm
    //     even when nobody has the app open)
    try {
      await refreshTop10Month();
      await refreshArriving();
    } catch (err) {
      console.error("[cron] top10/arriving refresh failed:", String(err).slice(0, 200));
    }
  });
  checks.push({ name: "catalog-sync", ok: true, detail: "background heal scheduled (dub catch-up sweep + sync + skip prefetch + airing-soon pushes + audit + top10/arriving refresh)" });

  // ---- 4) orphaned comment replies -> remove (heal, DB-only) ----
  try {
    const orphans = await db.comment.findMany({
      where: { parentId: { not: null } },
      select: { id: true, parentId: true },
      take: 500,
    });
    const parentIds = new Set(
      (
        await db.comment.findMany({
          where: { id: { in: orphans.map((o) => o.parentId!).filter(Boolean) } },
          select: { id: true },
        })
      ).map((p) => p.id),
    );
    const broken = orphans.filter((o) => o.parentId && !parentIds.has(o.parentId));
    if (broken.length > 0) {
      await db.comment.deleteMany({ where: { id: { in: broken.map((b) => b.id) } } });
      fixes.push(`removed ${broken.length} orphaned reply/replies`);
      checks.push({ name: "comment-tree", ok: false, detail: `${broken.length} orphans` });
    } else {
      checks.push({ name: "comment-tree", ok: true, detail: "no orphaned replies" });
    }
  } catch (err) {
    checks.push({ name: "comment-tree", ok: false, detail: String(err).slice(0, 200) });
  }

  // ---- 5) comment likes JSON sanity -> reset malformed rows (heal) ----
  try {
    const suspicious = await db.comment.findMany({
      where: { NOT: { likedBy: { startsWith: "[" } } },
      select: { id: true },
      take: 100,
    });
    if (suspicious.length > 0) {
      await db.comment.updateMany({
        where: { id: { in: suspicious.map((c) => c.id) } },
        data: { likedBy: "[]" },
      });
      fixes.push(`reset malformed like counters on ${suspicious.length} comment(s)`);
    }
    checks.push({ name: "comment-likes-json", ok: true, detail: `${suspicious.length} malformed` });
  } catch (err) {
    checks.push({ name: "comment-likes-json", ok: false, detail: String(err).slice(0, 200) });
  }

  // ---- 6) progress rows sanity (report only — user data is never auto-deleted) ----
  try {
    const progressCount = await db.watchProgress.count();
    const commentCount = await db.comment.count();
    checks.push({ name: "user-data", ok: true, detail: `${progressCount} progress rows / ${commentCount} comments` });
  } catch (err) {
    healthy = false;
    checks.push({ name: "user-data", ok: false, detail: String(err).slice(0, 200) });
  }

  // ---- 7) top 10 events feed (bell data path — pure read; the chart
  //     refresh itself is part of the background heal above) ----
  try {
    const total = await db.top10Event.count();
    const latest = await db.top10Event.findFirst({
      orderBy: { id: "desc" },
      select: { type: true, title: true, rank: true, createdAt: true },
    });
    const label =
      latest?.type === "up"
        ? `climbed to #${latest.rank}`
        : latest?.type === "down"
          ? `fell to #${latest.rank}`
          : latest?.type === "enter"
            ? "entered the Top 10"
            : "left the Top 10";
    checks.push({
      name: "top10-events",
      ok: true,
      detail: latest
        ? `${total} rank-change event(s); latest: ${latest.title} ${label} (${latest.createdAt.toISOString()})`
        : "no rank-change events yet (bell stays empty until the Top 10 moves)",
    });
  } catch (err) {
    healthy = false;
    checks.push({ name: "top10-events", ok: false, detail: String(err).slice(0, 200) });
  }

  // ---- 8) intro-scout fleet status (the 24/7 bots that measure openings;
  // report-only — the fleet runs off-site and reports via its own API) ----
  try {
    const [measured, refs, latest] = await Promise.all([
      db.introScout.count(),
      db.scoutRef.count(),
      db.scoutFinding.findFirst({ orderBy: { id: "desc" }, select: { bot: true, title: true, ep: true, start: true, end: true, status: true, createdAt: true } }),
    ]);
    const ago = latest ? Math.round((Date.now() - latest.createdAt.getTime()) / 60000) : null;
    checks.push({
      name: "intro-scout-fleet",
      ok: true,
      detail: `${measured} episode opening(s) measured, ${refs} anime reference(s); latest: ${latest ? `${latest.bot} -> ${latest.title} ep${latest.ep} ${latest.status}${latest.start != null ? ` ${latest.start}-${latest.end}s` : ""} (${ago} min ago)` : "no reports yet"}`,
    });
  } catch (err) {
    checks.push({ name: "intro-scout-fleet", ok: false, detail: String(err).slice(0, 200) });
  }

  const report = {
    ok: healthy,
    startedAt,
    finishedAt: new Date().toISOString(),
    origin: new URL(req.url).origin,
    checks,
    fixes,
    note: "heavy heals (sync / audit / top10 refresh) run in background via after()",
  };
  // visible in Vercel logs so failures surface without anyone opening the app
  console.log("[cron] self-test report:", JSON.stringify(report));

  return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
}
