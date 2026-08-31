import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { syncCatalog, lastSync } from "@/lib/sync";

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
