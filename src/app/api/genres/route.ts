import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { POPULAR_GENRES, OG_GENRE, ogNicheVaultWhere } from "@/lib/catalog-seed";

export const dynamic = "force-dynamic";

/**
 * GET /api/genres — the POPULAR genres only (curated), filtered to genres the
 * catalog actually has, sorted most titles first. Niche tags never show up as
 * empty tiles.
 *
 * "OG" is appended as a pseudo-genre: the count is the NICHE pre-2010 vault
 * (same fame gate /api/genre/OG serves — see ogNicheVaultWhere), so the tile
 * reflects the real size of the hidden-classics vault.
 */
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
  const ogCount = await db.anime.count({
    where: ogNicheVaultWhere(),
  });
  const genres = [
    { name: OG_GENRE, count: ogCount },
    ...POPULAR_GENRES.map((name) => ({ name, count: counts.get(name) ?? 0 })),
  ]
    .filter((g) => g.count > 0)
    .sort((a, b) => b.count - a.count);
  return NextResponse.json({ genres });
}
