import { NextResponse } from "next/server";
import { syncCatalog, lastSync, syncInProgress } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** GET /api/sync — status of the last sync. */
export async function GET() {
  const sync = await lastSync();
  return NextResponse.json({ ...sync, syncing: syncInProgress() });
}

/** POST /api/sync — run a catalog sync NOW (new episodes + new season anime). */
export async function POST() {
  const result = await syncCatalog();
  const sync = await lastSync();
  return NextResponse.json({ ...result, lastSync: sync.at, syncing: syncInProgress() });
}
