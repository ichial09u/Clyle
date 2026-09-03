import { NextResponse, after } from "next/server";
import { db } from "@/lib/db";
import { freshMediaByMal, airedEpisodeCount } from "@/lib/anilist";
import { importEpisodes, importEpisodesFromList, episodeTitleBackfillPages, backfillEpisodeTitles } from "@/lib/sync";
import { prefetchSkipTimes } from "@/lib/skip-times";
import { probeDubAvailable } from "@/lib/zoko-stream";
import { probeMegaplayDub, storeMegaplayVerdict } from "@/lib/megaplay";

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
  const freshEpisodes: number[] = [];
  if (anime.airing) {
    const media = await freshMediaByMal(malId);
    const aired = airedEpisodeCount(media);
    if (aired != null) {
      if (aired > anime.totalEpisodes) {
        await db.anime.update({ where: { malId }, data: { totalEpisodes: aired } });
        const added = await importEpisodes(malId, aired);
        newlyAdded = added.length;
        freshEpisodes.push(...added);
      }
    } else {
      // no schedule yet (or AniList unreachable) — probe MAL's episode list
      const added = await importEpisodesFromList(malId);
      newlyAdded = added.length;
      freshEpisodes.push(...added);
    }
    // brand-new episodes import their skip intro/ending along with them
    // (background, rate-limited, after the response is flushed)
    if (freshEpisodes.length) after(() => prefetchSkipTimes(freshEpisodes.map((ep) => ({ malId, ep, lenMin: anime.durationMin })), 8));
  }

  // real episode titles ("Episode 1: Ryomen Sukuna") — rows created from
  // AniList's aired count have none. Small gaps fill inline (one Jikan page
  // for a normal show, so even the very first visit sees titles); large
  // gaps (long-runners) run after the response flushes so this route stays
  // snappy. Fully-titled anime skip all of this for the price of one query.
  const titlePages = await episodeTitleBackfillPages(malId);
  if (titlePages > 0) {
    if (titlePages <= 2) {
      await backfillEpisodeTitles(malId).catch(() => undefined);
    } else {
      after(() => backfillEpisodeTitles(malId).catch(() => undefined));
    }
  }

  const episodes = await db.episode.findMany({
    where: { animeId: malId, lang: "sub" },
    orderBy: { number: "asc" },
    select: { number: true, title: true, aired: true, addedAt: true },
  });

  // fall back to the stored count if the episode table has not caught up yet
  const total = episodes.length > 0 ? episodes[episodes.length - 1].number : anime.totalEpisodes;

  // does a REAL DUB exist for this show? probe once per server, remember.
  // The verdict is per-anime (probed at ep 1) — individual later episodes
  // just 404 at play time until the dub catches up.
  let hasDub = anime.hasDub;
  let hasDubKiwi = anime.hasDubKiwi;
  let hasDubMega = anime.hasDubMega;
  const probeJobs: Array<Promise<void>> = [];
  if (hasDub == null) {
    probeJobs.push(
      probeDubAvailable(malId, 1).then((v) => {
        if (v != null) {
          hasDub = v;
          void db.anime.update({ where: { malId }, data: { hasDub: v } }).catch(() => undefined);
        }
      }),
    );
  }
  if (hasDubKiwi == null) {
    probeJobs.push(
      probeDubAvailable(malId, 1, "kiwi").then((v) => {
        if (v != null) {
          hasDubKiwi = v;
          void db.anime.update({ where: { malId }, data: { hasDubKiwi: v } }).catch(() => undefined);
        }
      }),
    );
  }
  // missing-dub backfill: when neither Zoko nor Kiwi carries a real dub,
  // probe the Megaplay/yenime source once — that's what fills the gap.
  if (hasDub === false && hasDubKiwi === false && hasDubMega == null) {
    probeJobs.push(
      probeMegaplayDub(malId, 1).then((v) => {
        if (v != null) {
          hasDubMega = v;
          void storeMegaplayVerdict(malId, v);
        }
      }),
    );
  }
  await Promise.all(probeJobs);

  // null = not probed -> optimistic (show DUB; the stream API validates)
  const dubServers: Array<"zoko" | "kiwi"> = [];
  if (hasDub !== false) dubServers.push("zoko");
  if (hasDubKiwi !== false) dubServers.push("kiwi");
  // no Zoko/Kiwi dub but the backfill source has one — still offer both DUB
  // buttons; /api/stream transparently lands them on the backfill source
  if (!dubServers.length && hasDubMega === true) dubServers.push("zoko", "kiwi");

  return NextResponse.json({
    malId,
    title: anime.titleEnglish?.trim() || anime.title,
    type: anime.type,
    airing: anime.airing,
    durationMin: anime.durationMin,
    total,
    hasDub: dubServers.length > 0,
    dubServers,
    episodes: episodes.map((e) => ({ number: e.number, title: e.title, aired: e.aired, addedAt: e.addedAt })),
    newlyAdded,
  });
}
