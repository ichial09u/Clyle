import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { POPULAR_GENRES, OG_GENRE, POKEMON_GENRE, SOUTHPARK_GENRE, ogNicheVaultWhere } from "@/lib/catalog-seed";

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
  // Pokémon — franchise pseudo-genre (import tags every entry with it); the
  // wordmark tile is PINNED to the front of the grid when the vault is live
  const pokeCount = await db.anime.count({
    where: { inCatalog: true, genres: { contains: `%"${POKEMON_GENRE}"%` } },
  });
  // South Park — same franchise-tile pattern (one entry, all seasons, WCO
  // source); pinned right after Pokémon
  const spCount = await db.anime.count({
    where: { inCatalog: true, genres: { contains: `%"${SOUTHPARK_GENRE}"%` } },
  });
  const genres = [
    ...(pokeCount > 0 ? [{ name: POKEMON_GENRE, count: pokeCount }] : []),
    ...(spCount > 0 ? [{ name: SOUTHPARK_GENRE, count: spCount }] : []),
    { name: OG_GENRE, count: ogCount },
    ...POPULAR_GENRES.map((name) => ({ name, count: counts.get(name) ?? 0 })),
  ]
    .filter((g) => g.count > 0)
    .sort((a, b) => b.count - a.count)
    // re-pin the franchise tiles to the front after the size sort
    .sort((a, b) =>
      a.name === POKEMON_GENRE
        ? -1
        : b.name === POKEMON_GENRE
          ? 1
          : a.name === SOUTHPARK_GENRE
            ? -1
            : b.name === SOUTHPARK_GENRE
              ? 1
              : 0,
    );
  // identical-for-everyone global data — let the CDN absorb the per-mount
  // refetch storm (the client used to full-scan the catalog on every open)
  return NextResponse.json({ genres }, { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } });
}
