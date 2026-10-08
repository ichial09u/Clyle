import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/progress/all?userId= — every WatchProgress row for one identity.
 * Powers the sign-in merge (lib/account.ts copies the anonymous device rows
 * onto the Google id), and the Profile screen's "you have N episodes of
 * progress" line. Tombstones are NOT included — removed titles stay removed.
 */
export async function GET(req: Request) {
  const userId = new URL(req.url).searchParams.get("userId")?.trim();
  if (!userId) return NextResponse.json({ error: "bad params" }, { status: 400 });

  const rows = await db.watchProgress.findMany({
    where: { userId },
    select: {
      malId: true,
      episode: true,
      lang: true,
      server: true,
      position: true,
      duration: true,
      completed: true,
      title: true,
      image: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
    take: 400, // heavy users must not page through thousands of rows per merge
  });

  return NextResponse.json(
    {
      rows: rows.map((r) => ({
        malId: r.malId,
        episode: r.episode,
        lang: r.lang,
        server: r.server,
        position: r.position,
        duration: r.duration,
        completed: r.completed,
        title: r.title,
        image: r.image,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
