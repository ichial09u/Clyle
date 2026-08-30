import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { jikan, jikanOne, type JikanAnime } from "@/lib/jikan";
import { lite } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/**
 * GET /api/search?q=one+piece
 * Catalog matches first (instant), then MAL-wide results (Zoko carries every
 * MAL id, and non-catalog hits can be imported with one tap).
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return NextResponse.json({ catalog: [], mal: [] });

  const like = `%${q.replace(/[%_]/g, "")}%`;
  const rows = await db.anime.findMany({
    where: {
      inCatalog: true,
      OR: [{ title: { contains: q } }, { titleEnglish: { contains: q } }],
    },
    orderBy: { popularity: "asc" },
    take: 12,
  });

  let catalog = rows.map(lite);

  // backfill missing images/details for freshly seeded rows
  const sparse = catalog.filter((c) => !c.image);
  if (sparse.length) {
    for (const s of sparse.slice(0, 6)) {
      const full = await jikanOne<JikanAnime>(`/anime/${s.malId}/full`);
      if (full) await db.anime.update({ where: { malId: s.malId }, data: { image: full.images?.webp?.large_image_url ?? full.images?.jpg?.image_url ?? null } });
    }
    const refreshed = await db.anime.findMany({
      where: { inCatalog: true, OR: [{ title: { contains: q } }, { titleEnglish: { contains: q } }] },
      orderBy: { popularity: "asc" },
      take: 12,
    });
    catalog = refreshed.map(lite);
  }

  const mal = await jikan<{ data: JikanAnime[] }>(
    `/anime?q=${encodeURIComponent(q)}&limit=18&sfw=true&order_by=members&sort=desc`,
    { retries: 1 },
  );
  const catalogIds = new Set(catalog.map((c) => c.malId));
  const results = (mal?.data ?? [])
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
