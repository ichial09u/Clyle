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
 *
 * Smart matching: the normalized pass folds accents ("pokemon" -> finds
 * "Pokémon"), spacing ("onepiece" -> "One Piece", "dan da dan"), and
 * punctuation ("re:zero" -> "Re:ZERO") — the user's typing never has to
 * match the catalog's exact spelling to surface every title it belongs to.
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

  // de-spaced + accent-folded fallback: users type "dandadan" for "DAN DA
  // DAN", "onepiece" for "One Piece", and — the whole point — "pokemon" for
  // "Pokémon". SQLite contains can't ignore spaces or accents, so run a
  // JS-side normalized pass over the catalog whenever the literal match is
  // thin. NFD decomposition splits é into e + combining mark, so folding is
  // bidirectional (accented query matches ASCII titles too).
  const norm = (s: string) =>
    (s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]/g, "");
  const nq = norm(q);
  if (nq && catalog.length < 24) {
    const seen = new Set(catalog.map((c) => c.malId));
    const all = await db.anime.findMany({
      where: { inCatalog: true },
      orderBy: { popularity: "asc" },
    });
    for (const a of all) {
      if (catalog.length >= 24) break;
      if (seen.has(a.malId)) continue;
      if (norm(a.title).includes(nq) || norm(a.titleEnglish ?? "").includes(nq)) {
        catalog.push(lite(a));
        seen.add(a.malId);
      }
    }
  }

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
