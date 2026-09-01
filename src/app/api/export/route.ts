import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/export — full dump of the irreplaceable user data:
 *   users + comments (the point of this endpoint: the deploy script fetches
 *   this BEFORE building a new deployment and merges it into the bundled
 *   SQLite file, so comments survive site updates), plus the Top 10 Today
 *   history (watchStats), its notification events, and the seal cursor.
 *
 * Everything here is already public through the app (no progress/identity
 * secrets). Used by scripts/merge-comments.mjs via scripts/deploy-vercel.mjs.
 */
export async function GET() {
  const [users, comments, watchStats, top10Events, top10Meta] = await Promise.all([
    db.user.findMany({ select: { id: true, nickname: true, avatar: true, createdAt: true } }),
    db.comment.findMany(),
    db.watchStat.findMany(),
    db.top10Event.findMany(),
    db.top10Meta.findMany(),
  ]);
  return NextResponse.json(
    { exportedAt: new Date().toISOString(), users, comments, watchStats, top10Events, top10Meta },
    { headers: { "Cache-Control": "no-store" } },
  );
}
