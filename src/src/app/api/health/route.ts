import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Deployment self-diagnosis. Reports whether the packaged catalog DB is
 * reachable and whether Prisma can actually query it — used to verify the
 * Docker/Render deployment without shell access to the container.
 */
export async function GET() {
  const dbPath = join(process.cwd(), "db", "custom.db");
  let animeCount: number | null = null;
  let dbError: string | null = null;
  try {
    const rows = await db.$queryRawUnsafe<{ n: number }[]>(
      'SELECT COUNT(*) as n FROM "Anime"',
    );
    animeCount = rows?.[0]?.n ?? null;
  } catch (e) {
    dbError = String(e instanceof Error ? e.message : e).slice(0, 400);
  }

  return NextResponse.json({
    ok: true,
    node: process.version,
    cwd: process.cwd(),
    dbPath,
    dbExists: existsSync(dbPath),
    databaseUrl: (process.env.DATABASE_URL ?? "").slice(0, 80),
    animeCount,
    dbError,
    ts: new Date().toISOString(),
  });
}
