import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sealTop10Days } from "@/lib/top10";

export const dynamic = "force-dynamic";

/**
 * Top 10 Today notifications for the bell button:
 *   "X entered the Top 10 Today" / "X left the Top 10 Today".
 *
 * Opening the bell also runs the day-seal, so yesterday's final list is
 * published (and its leave/enter events recorded) even if nobody fetched
 * the rail that morning. Read state is per-device (localStorage) — the
 * server feed is the same for every viewer.
 *
 * GET /api/top10-events -> { events: [{ id, type, malId, day, title, image, rank, weeks, createdAt }] }
 *   leaves carry `weeks` = full weeks the anime was up (0 = less than 7 days).
 */
export async function GET() {
  await sealTop10Days();
  const events = await db.top10Event.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 50,
  });
  return NextResponse.json({ events }, { headers: { "Cache-Control": "no-store" } });
}
