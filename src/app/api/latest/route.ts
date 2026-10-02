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

  // group newest episode per anime — carrying the newest episode's REAL title
  // ("The Forbidden Continent") so the Latest row reads
  // "Episode 1180: The Forbidden Continent available" instead of a bare
  // "Episode 1180 available" (the grab-the-episode-name ask).
  const perAnime = new Map<number, { anime: ReturnType<typeof lite>; latest: number; latestTitle: string | null; total: number; updatedAt: string }>();
  for (const ep of recentEpisodes) {
    if (!ep.anime.inCatalog) continue;
    const existing = perAnime.get(ep.anime.malId);
    if (existing) {
      if (ep.number > existing.latest) {
        existing.latest = ep.number;
        existing.latestTitle = ep.title ?? null;
      }
    } else {
      perAnime.set(ep.anime.malId, {
        anime: lite(ep.anime),
        latest: ep.number,
        latestTitle: ep.title ?? null,
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
