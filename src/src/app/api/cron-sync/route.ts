import { NextResponse, after } from "next/server";
import { syncCatalog, lastSync, syncInProgress } from "@/lib/sync";
import { prefetchSkipTimes } from "@/lib/skip-times";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/cron-sync — LIGHT scheduled episode import (Vercel cron #2).
 *
 * /api/cron runs the full daily self-test + self-heal; this endpoint ONLY
 * runs the catalog sync, so freshly-aired episodes land twice a day even
 * when nobody opens the app (Vercel Hobby allows exactly two cron jobs:
 * the full one at 07:17 UTC, this one at 19:17 UTC). The client-side loop
 * in page.tsx covers everything in between while the app is open.
 */
export async function GET() {
  const startedAt = new Date().toISOString();
  try {
    const result = await syncCatalog();
    const sync = await lastSync();
    // newly imported episodes bring their skip intro/ending along (background)
    if (result.newEpisodes.length) after(() => prefetchSkipTimes(result.newEpisodes));
    const report = {
      ok: result.ok !== false,
      startedAt,
      finishedAt: new Date().toISOString(),
      episodesAdded: result.episodesAdded,
      animeAdded: result.animeAdded,
      animeChecked: result.animeChecked,
      lastSync: sync.at,
      syncing: syncInProgress(),
    };
    // visible in Vercel logs
    console.log("[cron-sync]", JSON.stringify(report));
    return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[cron-sync] failed:", err);
    return NextResponse.json(
      { ok: false, startedAt, error: String(err).slice(0, 300) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
