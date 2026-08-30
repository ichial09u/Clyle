import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { jikan, type JikanAnime } from "@/lib/jikan";
import { lite } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/** GET /api/genre/{name} — catalog anime for a genre + import suggestions from MAL. */
export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const genre = decodeURIComponent(name);
  const like = `%"${genre.replace(/[%_]/g, "")}"%`;

  const rows = await db.anime.findMany({
    where: { inCatalog: true, genres: { contains: like } },
    orderBy: { popularity: "asc" },
    take: 30,
  });
  const catalog = rows.map(lite);

  let suggestions: Array<{ malId: number; title: string; image: string | null; score: number | null }> = [];
  if (catalog.length < 12) {
    const res = await jikan<{ data: JikanAnime[] }>(
      `/anime?q=${encodeURIComponent(genre)}&order_by=members&sort=desc&sfw=true&limit=15`,
    );
    const have = new Set(catalog.map((c) => c.malId));
    suggestions = (res?.data ?? [])
      .filter((a) => !have.has(a.mal_id) && a.type === "TV")
      .slice(0, 12)
      .map((a) => ({
        malId: a.mal_id,
        title: a.title,
        image: a.images?.webp?.large_image_url ?? a.images?.jpg?.image_url ?? null,
        score: a.score ?? null,
      }));
  }

  return NextResponse.json({ genre, catalog, suggestions });
}
