import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ALL_GENRES } from "@/lib/catalog-seed";

export const dynamic = "force-dynamic";

/** GET /api/genres — the full MAL genre/theme grid (like the app) with catalog counts. */
export async function GET() {
  const rows = await db.anime.findMany({ where: { inCatalog: true }, select: { genres: true } });
  const counts = new Map<string, number>();
  for (const r of rows) {
    try {
      for (const g of JSON.parse(r.genres) as string[]) {
        counts.set(g, (counts.get(g) ?? 0) + 1);
      }
    } catch {
      /* ignore */
    }
  }
  return NextResponse.json({
    genres: ALL_GENRES.map((name) => ({ name, count: counts.get(name) ?? 0 })),
  });
}
