import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Deployment self-diagnosis + liveness probe in one endpoint. Reports whether
 * the packaged catalog DB is reachable and whether Prisma can actually query
 * it — used to verify the Docker/Render deployment without shell access to
 * the container, and doubles as the keep-alive target for uptime monitors and
 * the Dokploy compose healthcheck.
 *
 * 200 = server up AND catalog DB queryable; 503 = DB unreachable, so
 * orchestrators show a red light instead of a lying green one.
 */
export async function GET() {
  const dbPath = join(process.cwd(), "db", "custom.db");
  let animeCount: number | null = null;
  let dbError: string | null = null;
  try {
    animeCount = await db.anime.count();
  } catch (e) {
    dbError = String(e instanceof Error ? e.message : e).slice(0, 400);
  }

  return NextResponse.json(
    {
      ok: dbError === null,
      node: process.version,
      cwd: process.cwd(),
      dbPath,
      dbExists: existsSync(dbPath),
      // DATABASE_URL's first 80 chars used to be world-readable here — with a
      // future postgres:// URL that leaks user@host (and a credential prefix).
      // dbExists/animeCount already say whether the URL resolved.
      databaseUrlScheme: (process.env.DATABASE_URL ?? "").split(":")[0] || null,
      animeCount,
      dbError,
      ts: new Date().toISOString(),
    },
    {
      status: dbError === null ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
