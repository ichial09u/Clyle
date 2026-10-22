import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/health — liveness + catalog DB probe for uptime monitors and
 * container healthchecks (Dokploy compose pings this path, and it doubles
 * as a Render/UptimeRobot keep-alive target).
 *
 * 200 when the server can actually query the catalog DB (count proves the
 * schema exists — catches the classic "no such table" boot failure),
 * 503 when it cannot, so orchestrators surface a red light instead of a
 * lying green one.
 */
export async function GET() {
  try {
    const titles = await db.anime.count({ where: { inCatalog: true } });
    return NextResponse.json(
      { ok: true, db: "up", titles, ts: new Date().toISOString() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { ok: false, db: "down", error: "catalog_db_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
