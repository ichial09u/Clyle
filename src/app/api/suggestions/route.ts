import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { lite } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/**
 * GET /api/suggestions?userId=<uuid>
 *
 * "Suggested For You" — the companion rail for Continue Watching. Reads what
 * the user is actually watching, takes those shows' genres, and ranks catalog
 * anime they haven't started by shared-genre overlap (popularity as the
 * tiebreaker). Falls back to the catalog's most popular titles when the
 * history is too thin to infer anything.
 */
export async function GET(req: Request) {
  const userId = new URL(req.url).searchParams.get("userId");
  if (!userId) return NextResponse.json({ items: [] }, { status: 400 });

  // what the user is watching right now (one entry per anime, freshest first)
  const rows = await db.watchProgress.findMany({
    where: { userId, position: { gt: 5 } },
    orderBy: { updatedAt: "desc" },
    take: 60,
  });
  const seen = new Set<number>();
  const watchingIds: number[] = [];
  for (const r of rows) {
    if (!seen.has(r.malId)) {
      seen.add(r.malId);
      watchingIds.push(r.malId);
    }
  }

  if (!watchingIds.length) {
    // nothing to infer from yet — surface the catalog's most popular titles
    const popular = await db.anime.findMany({
      where: { inCatalog: true },
      orderBy: { popularity: "asc" },
      take: 12,
    });
    return NextResponse.json({ items: popular.map(lite) }, { headers: { "Cache-Control": "no-store" } });
  }

  const watching = await db.anime.findMany({
    where: { malId: { in: watchingIds } },
    select: { malId: true, title: true, titleEnglish: true, genres: true },
  });

  // genre -> how strongly the user's current shows point at it (weighted by
  // recency: the most recent watch counts most)
  const genreWeight = new Map<string, number>();
  const anchorTitle = watching.find((a) => a.malId === watchingIds[0]);
  for (const a of watching) {
    const recency = 1 / (1 + watchingIds.indexOf(a.malId) * 0.5);
    for (const g of JSON.parse(a.genres || "[]") as string[]) {
      genreWeight.set(g, (genreWeight.get(g) ?? 0) + recency);
    }
  }
  const topGenres = [...genreWeight.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([g]) => g);

  // candidate pool: popular catalog titles in those genres that the user
  // hasn't started (or already finished)
  const pool = await db.anime.findMany({
    where: { inCatalog: true, malId: { notIn: watchingIds } },
    orderBy: { popularity: "asc" },
    take: 400,
  });

  const scored = pool
    .map((a) => {
      const genres = JSON.parse(a.genres || "[]") as string[];
      const overlap = genres.filter((g) => topGenres.includes(g)).length;
      return { a, overlap };
    })
    .filter((s) => s.overlap > 0)
    .sort((x, y) => y.overlap - x.overlap || (x.a.popularity ?? 9e9) - (y.a.popularity ?? 9e9))
    .slice(0, 12);

  // pool thin (tiny catalog slice matched nothing)? top up with popular titles
  let items = scored.map((s) => s.a);
  if (items.length < 6) {
    const extra = await db.anime.findMany({
      where: { inCatalog: true, malId: { notIn: [...watchingIds, ...items.map((i) => i.malId)] } },
      orderBy: { popularity: "asc" },
      take: 12 - items.length,
    });
    items = [...items, ...extra];
  }

  return NextResponse.json(
    {
      items: items.map(lite),
      becauseOf: anchorTitle?.titleEnglish?.trim() || anchorTitle?.title || null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
