import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isOwnerRequest, OWNER_HEADER } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * GET /api/export — full dump of the irreplaceable user data:
 *   users + comments (the point of this endpoint: the deploy script fetches
 *   this BEFORE building a new deployment and merges it into the bundled
 *   SQLite file, so comments survive site updates), plus the Top 10 Today
 *   history (watchStats), its notification events, the seal cursor, and the
 *   Web Push subscriptions (without carrying those forward, every deploy
 *   would silently unsubscribe the lock-screen notifications until each
 *   browser happened to reopen the app).
 *
 * Owner-only: the dump carries per-user watch history and Web Push keys, so
 * it requires the x-clyle-owner header (CLYLE_OWNER_TOKEN). The local merge
 * scripts send it; everyone else gets a 403.
 */
export async function GET(req: Request) {
  if (!isOwnerRequest(req)) {
    return NextResponse.json(
      { error: "owner only" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  const [users, comments, watchStats, top10Events, top10Meta, deletedCommentIds, anime, episodes, watchProgress, removedProgress, introScout, scoutRef, dubProbe, pushSubs] =
    await Promise.all([
      db.user.findMany({ select: { id: true, nickname: true, avatar: true, createdAt: true } }),
      db.comment.findMany(),
      db.watchStat.findMany(),
      db.top10Event.findMany(),
      db.top10Meta.findMany(),
      db.deletedComment.findMany({ select: { id: true } }),
      // catalog + playback data so deploys never wipe what the live site
      // accumulated (imports ran on the lambda's writable db copy — without
      // carrying them forward the next deployment would reset the catalog)
      db.anime.findMany({ where: { inCatalog: true } }),
      db.episode.findMany({
        select: { animeId: true, number: true, title: true, aired: true, lang: true, filler: true, recap: true, addedAt: true },
      }),
      db.watchProgress.findMany({
        select: { userId: true, malId: true, episode: true, lang: true, server: true, position: true, duration: true, completed: true, title: true, image: true, updatedAt: true },
      }),
      // removal tombstones — without these a redeploy resurrects every item
      // the viewer deliberately deleted from Continue Watching
      db.removedProgress.findMany({
        select: { userId: true, malId: true, removedAt: true },
      }),
      // intro-scout fleet measurements (Skip Intro accuracy data — the
      // fleet re-measures over days, but carrying these forward keeps the
      // button accurate through the deploy itself)
      db.introScout.findMany(),
      db.scoutRef.findMany(),
      // per-episode dub probes (ground truth behind the DUB button gating)
      db.dubProbe.findMany(),
      // Web Push subscriptions — lock-screen delivery must survive deploys
      db.pushSub.findMany(),
    ]);
  return NextResponse.json(
    {
      exportedAt: new Date().toISOString(),
      users,
      comments,
      watchStats,
      top10Events,
      top10Meta,
      deletedCommentIds: deletedCommentIds.map((d) => d.id),
      anime,
      episodes,
      watchProgress,
      removedProgress,
      introScout,
      scoutRef,
      dubProbe,
      pushSubs,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
