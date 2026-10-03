import { NextResponse, after } from "next/server";
import { db } from "@/lib/db";
import { refreshTop10Month } from "@/lib/top10-month";

export const dynamic = "force-dynamic";

/**
 * Top 10 rank-change notifications for the bell button:
 *   "surpassed #3 — now #2" / "fell to #5" / "entered the Top 10" /
 *   "left the Top 10".
 *
 * The feed is driven by the TMDB-popularity ranking (top10-month.ts). A
 * refresh is triggered opportunistically (rate-limited to once per TTL) so
 * the bell has fresh news without waiting for the cron. It runs via after()
 * so it survives the response on Vercel (a floating promise gets frozen);
 * the client's open-kick "?fresh=1" on /api/top10 is what forces it past
 * the TTL. Read state is per-device (localStorage); the server feed is the
 * same for every viewer.
 *
 * GET /api/top10-events -> { events: [{ id, type, malId, day, title, image, rank, prevRank, createdAt }] }
 */
export async function GET() {
  // rate-limited inside refreshTop10Month (2h TTL, in-flight deduped)
  after(() => refreshTop10Month().catch(() => undefined));
  const events = await db.top10Event.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 50,
  });
  return NextResponse.json({ events }, { headers: { "Cache-Control": "no-store" } });
}
