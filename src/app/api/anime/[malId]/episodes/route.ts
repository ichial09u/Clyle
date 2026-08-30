import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { freshMediaByMal, airedEpisodeCount } from "@/lib/anilist";
import { importEpisodes, importEpisodesFromList } from "@/lib/sync";

export const dynamic = "force-dynamic";

/**
 * GET /api/anime/{malId}/episodes
 *
 * Episodes are materialised locally (numbers + dates) so the app can show
 * the grid instantly and badge new arrivals; playback itself always uses
 * Zoko's player URL. If more episodes have aired than we know of, they are
 * imported here and now — "import immediately".
 *
 * Freshness source: AniList (single lightweight request; its
 * nextAiringEpisode pinpoints exactly how many episodes have aired, which
 * even covers long-runners like One Piece). Falls back to probing MAL's
 * paginated episode list when AniList has no schedule for the show.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ malId: string }> }) {
  const { malId: malIdStr } = await params;
  const malId = parseInt(malIdStr, 10);
  if (!Number.isFinite(malId)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const anime = await db.anime.findUnique({ where: { malId } });
  if (!anime) return NextResponse.json({ error: "not found" }, { status: 404 });

  // freshness check for airing shows — pulls the aired episode count from AniList
  let newlyAdded = 0;
  if (anime.airing) {
    const media = await freshMediaByMal(malId);
    const aired = airedEpisodeCount(media);
    if (aired != null) {
      if (aired > anime.totalEpisodes) {
        await db.anime.update({ where: { malId }, data: { totalEpisodes: aired } });
        newlyAdded = await importEpisodes(malId, aired);
      }
    } else {
      // no schedule yet (or AniList unreachable) — probe MAL's episode list
      newlyAdded = await importEpisodesFromList(malId);
    }
  }

  const episodes = await db.episode.findMany({
    where: { animeId: malId, lang: "sub" },
    orderBy: { number: "asc" },
    select: { number: true, title: true, aired: true, addedAt: true },
  });

  // fall back to the stored count if the episode table has not caught up yet
  const total = episodes.length > 0 ? episodes[episodes.length - 1].number : anime.totalEpisodes;

  return NextResponse.json({
    malId,
    title: anime.title,
    type: anime.type,
    airing: anime.airing,
    durationMin: anime.durationMin,
    total,
    episodes: episodes.map((e) => ({ number: e.number, title: e.title, aired: e.aired, addedAt: e.addedAt })),
    newlyAdded,
  });
}
