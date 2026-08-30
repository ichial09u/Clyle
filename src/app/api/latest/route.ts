import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { lite } from "@/lib/serialize";
import { lastSync, syncInProgress } from "@/lib/sync";

export const dynamic = "force-dynamic";

/** GET /api/latest — freshest catalog entries & episodes (the Latest tab). */
export async function GET() {
  const recentEpisodes = await db.episode.findMany({
    where: { lang: "sub" },
    orderBy: { addedAt: "desc" },
    take: 240,
    include: { anime: true },
  });

  // group newest episode per anime
  const perAnime = new Map<number, { anime: ReturnType<typeof lite>; latest: number; total: number; updatedAt: string }>();
  for (const ep of recentEpisodes) {
    if (!ep.anime.inCatalog) continue;
    const existing = perAnime.get(ep.anime.malId);
    if (existing) {
      existing.latest = Math.max(existing.latest, ep.number);
    } else {
      perAnime.set(ep.anime.malId, {
        anime: lite(ep.anime),
        latest: ep.number,
        total: ep.anime.totalEpisodes,
        updatedAt: ep.addedAt.toISOString(),
      });
    }
  }

  const updates = [...perAnime.values()]
    .sort((a, b) => {
      // rank by recency of the latest episode number relative to total (airing shows first)
      const aAiring = a.anime.airing ? 1 : 0;
      const bAiring = b.anime.airing ? 1 : 0;
      if (aAiring !== bAiring) return bAiring - aAiring;
      return b.updatedAt.localeCompare(a.updatedAt);
    })
    .slice(0, 30);

  const sync = await lastSync();
  return NextResponse.json({
    updates,
    lastSync: sync.at,
    syncing: syncInProgress(),
  });
}
