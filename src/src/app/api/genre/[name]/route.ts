import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { anilistToJikan, animeByGenre } from "@/lib/anilist";
import { lite } from "@/lib/serialize";
import { OG_GENRE, POKEMON_GENRE, SOUTHPARK_GENRE, ogNicheVaultWhere } from "@/lib/catalog-seed";

export const dynamic = "force-dynamic";

/**
 * GET /api/genre/{name} — catalog anime for a genre + import suggestions from AniList.
 *
 * "OG" is the pseudo-genre (see catalog-seed.ts): the NICHE pre-2010 vault —
 * in-catalog anime that started airing in OG_MAX_YEAR or earlier MINUS the
 * famous head (MAL popularity rank / members fame gate in ogNicheVaultWhere),
 * so it reads as "animes people haven't heard about in a while or at all".
 * Most-obscure-first (popularity DESC — the higher the MAL popularity rank,
 * the fewer people know it), with unknown-rank rows sinking to the bottom.
 * AniList import suggestions are skipped (OG is not a tag AniList can
 * suggest for).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  // Next already decodes route params; this second decode is for doubly-
  // encoded chips — but a param containing a bare "%" throws URIError, so
  // fall back to the raw param instead of a raw 500
  let genre = name;
  try {
    genre = decodeURIComponent(name);
  } catch {
    /* keep raw */
  }

  if (genre.toUpperCase() === OG_GENRE) {
    const rows = await db.anime.findMany({
      where: ogNicheVaultWhere(),
      // deepest cuts first; members ASC breaks ties (and popularity-unknown
      // rows sink to the bottom — SQLite would otherwise lead ASC with nulls,
      // and DESC would LEAD with them)
      orderBy: [{ popularity: { sort: "desc", nulls: "last" } }, { members: { sort: "asc", nulls: "last" } }],
      take: 500, // the whole vault today (~300 niche titles) — headroom without an unbounded query
    });
    return NextResponse.json({ genre: OG_GENRE, catalog: rows.map(lite), suggestions: [] });
  }

  const like = `%"${genre.replace(/[%_"]/g, "")}"%`;

  // South Park — spread out per season (Task 27; owner reversed the single
  // aggregator): 29 season entries + Movies & Specials, each with its own
  // TMDB per-season poster. Chronological order, Movies & Specials last.
  if (genre === SOUTHPARK_GENRE) {
    const rows = await db.anime.findMany({
      where: { inCatalog: true, genres: { contains: like } },
      take: 60, // 30 entries today — headroom without an unbounded query
    });
    rows.sort((a, b) => (a.malId === 999900 ? Infinity : a.malId) - (b.malId === 999900 ? Infinity : b.malId));
    return NextResponse.json({ genre, catalog: rows.map(lite), suggestions: [] });
  }

  // Pokémon serves in WATCH ORDER — release-chronological (Indigo League →
  // the movies of that era → the next series...), the way a franchise
  // marathon actually goes. Popularity order would put Journeys first.
  if (genre === POKEMON_GENRE) {
    const rows = await db.anime.findMany({
      where: { inCatalog: true, genres: { contains: like } },
      orderBy: [
        { year: { sort: "asc", nulls: "last" } },
        { popularity: { sort: "asc", nulls: "last" } },
      ],
      take: 150, // the whole franchise today (~86) — headroom without unbounded queries
    });
    return NextResponse.json({ genre, catalog: rows.map(lite), suggestions: [] });
  }

  const rows = await db.anime.findMany({
    where: { inCatalog: true, genres: { contains: like } },
    orderBy: { popularity: "asc" },
    take: 30,
  });
  const catalog = rows.map(lite);

  let suggestions: Array<{ malId: number; title: string; image: string | null; score: number | null }> = [];
  if (catalog.length < 12) {
    // top AniList anime in this genre (falls back to nothing if AniList is unreachable —
    // suggestions are optional sugar; the catalog grid itself is DB-backed and instant)
    const mediaList = await animeByGenre(genre);
    const have = new Set(catalog.map((c) => c.malId));
    suggestions = mediaList
      .map(anilistToJikan)
      .filter((a): a is NonNullable<typeof a> => !!a)
      .filter((a) => !have.has(a.mal_id) && a.type === "TV")
      .slice(0, 12)
      .map((a) => ({
        malId: a.mal_id,
        title: a.title,
        image: a.images?.webp?.large_image_url ?? a.images?.jpg?.large_image_url ?? a.images?.jpg?.image_url ?? null,
        score: a.score ?? null,
      }));
  }

  return NextResponse.json({ genre, catalog, suggestions });
}
