import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { mediaByMal } from "@/lib/anilist";
import { upsertAniListMedia } from "@/lib/sync";
import { lite } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/**
 * GET /api/search?q=one+piece
 *
 * Catalog-only search (instant, zero upstream calls). The old "More from
 * MAL" wide-search section is gone — results outside the catalog no longer
 * show up while searching.
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return NextResponse.json({ catalog: [], mal: [] });

  const match = {
    inCatalog: true,
    OR: [{ title: { contains: q } }, { titleEnglish: { contains: q } }],
  };

  const rows = await db.anime.findMany({
    where: match,
    orderBy: { popularity: "asc" },
    take: 24,
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
      where: match,
      orderBy: { popularity: "asc" },
      take: 24,
    });
    catalog = refreshed.map(lite);
  }

  return NextResponse.json({ catalog, mal: [] });
}
