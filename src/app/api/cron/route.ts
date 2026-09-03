import { NextResponse, after } from "next/server";
import { db } from "@/lib/db";
import { syncCatalog, lastSync } from "@/lib/sync";
import { prefetchSkipTimes } from "@/lib/skip-times";
import { runSkipAudit } from "@/lib/skip-audit";
import { refreshTop10Month } from "@/lib/top10-month";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/cron — scheduled self-test + self-heal entry point.
 *
 * Vercel Cron hits this on a schedule (see vercel.json). Each run:
 *   1. checks the database and catalog integrity,
 *   2. heals what is healable automatically (catalog drift -> re-sync,
 *      orphaned comment replies -> removed),
 *   3. returns a structured report (also printed to Vercel logs).
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

  // ---- 3) catalog drift -> auto re-sync (heal) ----
  try {
    const syncResult = await syncCatalog();
    const sync = await lastSync();
    if (syncResult.episodesAdded > 0 || syncResult.animeAdded > 0) {
      fixes.push(`catalog sync imported ${syncResult.episodesAdded} episodes / ${syncResult.animeAdded} anime`);
    }
    // import skip intro/ending for every newly imported episode (background,
    // rate-limited) — new episodes arrive with their skip data already cached
    if (syncResult.newEpisodes.length) after(() => prefetchSkipTimes(syncResult.newEpisodes));
    checks.push({ name: "catalog-sync", ok: syncResult.ok !== false, detail: `checked ${syncResult.animeChecked} anime · last run ${sync.at ?? "n/a"}` });
  } catch (err) {
    // upstream (Jikan) failures are not fatal for the app — record and move on
    checks.push({ name: "catalog-sync", ok: false, detail: String(err).slice(0, 200) });
  }

  // ---- 4) orphaned comment replies -> remove (heal) ----
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
        where: { id: { in: suspicious.map((s) => s.id) } },
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
    checks.push({ name: "user-data", ok: false, detail: String(err).slice(0, 200) });
  }

  // ---- 7) skip intro audit — the bot walks EVERY anime and verifies a
  // Skip Intro button will appear (exact dataset row / consensus / live tier
  // / TV-length heuristic). `probe` asks AniSkip live for gaps and caches
  // the answers, which heals them in place.
  try {
    const audit = await runSkipAudit(true, 5);
    const t = audit.totals;
    checks.push({
      name: "skip-intro-audit",
      ok: audit.ok,
      detail: `${t.coveragePct}% of ${t.sampled} sampled episodes show Skip Intro (${t.scout} scout / ${t.exact} exact / ${t.consensus} consensus / ${t.live} live / ${t.crowd} crowd / ${t.heuristic} heuristic / ${t.na} na / ${t.uncovered} uncovered, probed ${t.probed})`,
    });
    if (!audit.ok) {
      const bad = audit.anime.filter((a) => !a.ok).slice(0, 5).map((a) => `${a.title} (${a.episodes.filter((e) => e.source === "uncovered").map((e) => `ep${e.ep}`).join(",")})`);
      fixes.push(`skip intro still uncovered after probing: ${bad.join("; ")}`);
    }
  } catch (err) {
    checks.push({ name: "skip-intro-audit", ok: false, detail: String(err).slice(0, 200) });
  }

  // ---- 8) watch-time table (Top 10 Today data path) ----
  try {
    const day = new Date().toISOString().slice(0, 10);
    const rows = await db.watchStat.findMany({ where: { day }, orderBy: { seconds: "desc" }, take: 3 });
    const tracked = await db.watchStat.count({ where: { day } });
    checks.push({
      name: "watchtime-today",
      ok: true,
      detail: tracked
        ? `${tracked} anime watched today; leader at ${Math.round(rows[0].seconds / 60)}min`
        : "no watch time recorded today yet (Top 10 Today is empty until someone watches)",
    });
  } catch (err) {
    healthy = false;
    checks.push({ name: "watchtime-today", ok: false, detail: String(err).slice(0, 200) });
  }

  // ---- 9) top 10 rank notifications (bell data path) + Anime Trending refresh ----
  try {
    await refreshTop10Month(); // rate-limited inside (2h TTL)
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

  // ---- 10) intro-scout fleet status (the 24/7 bots that measure openings;
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
  };
  // visible in Vercel logs so failures surface without anyone opening the app
  console.log("[cron] self-test report:", JSON.stringify(report));

  return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
}
