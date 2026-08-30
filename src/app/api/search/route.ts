import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { jikan, type JikanAnime } from "@/lib/jikan";
import { anilistToJikan, mediaByMal, searchAnime } from "@/lib/anilist";
import { upsertAniListMedia } from "@/lib/sync";
import { lite } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/**
 * GET /api/search?q=one+piece
 * Catalog matches first (instant), then AniList-wide results (Zoko carries
 * every MAL id, and non-catalog hits can be imported with one tap).
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return NextResponse.json({ catalog: [], mal: [] });

  const rows = await db.anime.findMany({
    where: {
      inCatalog: true,
      OR: [{ title: { contains: q } }, { titleEnglish: { contains: q } }],
    },
    orderBy: { popularity: "asc" },
    take: 12,
  });

  let catalog = rows.map(lite);

  // backfill missing images/details for freshly seeded rows (via AniList)
  const sparse = catalog.filter((c) => !c.image);
  if (sparse.length) {
    for (const s of sparse.slice(0, 6)) {
      const media = await mediaByMal(s.malId);
      if (media) await upsertAniListMedia(media, { inCatalog: true, source: "seed" });
    }
    const refreshed = await db.anime.findMany({
      where: { inCatalog: true, OR: [{ title: { contains: q } }, { titleEnglish: { contains: q } }] },
      orderBy: { popularity: "asc" },
      take: 12,
    });
    catalog = refreshed.map(lite);
  }

  // wide search — AniList first (fast, reliable), Jikan as fallback
  let wide = await searchAnime(q);
  if (!wide.length) {
    const mal = await jikan<{ data: JikanAnime[] }>(
      `/anime?q=${encodeURIComponent(q)}&limit=18&sfw=true&order_by=members&sort=desc`,
      { retries: 1 },
    );
    wide = (mal?.data ?? []).map((a) => ({
      id: a.mal_id,
      idMal: a.mal_id,
      title: { romaji: a.title, english: a.title_english },
      coverImage: { extraLarge: a.images?.webp?.large_image_url ?? a.images?.jpg?.image_url ?? null },
      format: a.type === "Music" ? "MUSIC" : a.type === "Movie" ? "MOVIE" : a.type === "ONA" ? "ONA" : a.type === "OVA" ? "OVA" : "TV",
      year: a.year,
      averageScore: a.score != null ? Math.round(a.score * 10) : null,
    }));
  }

  const catalogIds = new Set(catalog.map((c) => c.malId));
  const results = wide
    .map(anilistToJikan)
    .filter((a): a is JikanAnime => !!a)
    .filter((a) => a.type === "TV" || a.type === "Movie" || a.type === "ONA")
    .filter((a) => !catalogIds.has(a.mal_id))
    .slice(0, 15)
    .map((a) => ({
      malId: a.mal_id,
      title: a.title,
      image: a.images?.webp?.large_image_url ?? a.images?.jpg?.image_url ?? null,
      type: a.type ?? null,
      year: a.year ?? null,
      score: a.score ?? null,
    }));

  return NextResponse.json({ catalog, mal: results });
}
