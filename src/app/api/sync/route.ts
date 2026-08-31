import { NextResponse, after } from "next/server";
import { syncCatalog, lastSync, syncInProgress } from "@/lib/sync";
import { prefetchSkipTimes } from "@/lib/skip-times";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** GET /api/sync — status of the last sync. */
export async function GET() {
  const sync = await lastSync();
  return NextResponse.json({ ...sync, syncing: syncInProgress() });
}

/** POST /api/sync — run a catalog sync NOW (new episodes + new season anime). */
export async function POST() {
  const result = await syncCatalog();
  const sync = await lastSync();
  // newly imported episodes bring their skip intro/ending along: warm the
  // AniSkip cache in the background, after the response is flushed
  if (result.newEpisodes.length) after(() => prefetchSkipTimes(result.newEpisodes));
  return NextResponse.json({ ...result, lastSync: sync.at, syncing: syncInProgress() });
}
