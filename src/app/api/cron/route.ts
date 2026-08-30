import { NextResponse } from "next/server";
import { syncCatalog, lastSync } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/cron — Vercel Cron entry point.
 *
 * Vercel Cron sends a GET request on a schedule (the Hobby plan allows one
 * run per day, which is plenty when combined with the client-side sync that
 * runs automatically every time the app opens after 30+ minutes of staleness).
 * This keeps the "import new episodes immediately" mechanism alive on Vercel
 * even when nobody has the app open.
 */
export async function GET() {
  const result = await syncCatalog();
  const sync = await lastSync();
  return NextResponse.json({ ok: true, ...result, lastSync: sync.at });
}
