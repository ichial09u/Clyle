import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/continue?userId=<uuid>
 *
 * Continue Watching: the most recent in-progress episode per anime, freshest
 * first, joined with the catalog row for up-to-date artwork/episode counts
 * (falls back to the snapshots stored on the progress row).
 */
export async function GET(req: Request) {
  const userId = new URL(req.url).searchParams.get("userId");
  if (!userId) return NextResponse.json({ items: [] }, { status: 400 });

  const rows = await db.watchProgress.findMany({
    where: { userId, completed: false, position: { gt: 5 } },
    orderBy: { updatedAt: "desc" },
    take: 40,
  });

  // one (latest) entry per anime
  const seen = new Set<number>();
  const latest = rows.filter((r) => {
    if (seen.has(r.malId)) return false;
    seen.add(r.malId);
    return true;
  });

  const malIds = latest.map((r) => r.malId);
  const catalog = malIds.length
    ? await db.anime.findMany({
        where: { malId: { in: malIds } },
        select: { malId: true, title: true, titleEnglish: true, image: true, banner: true, totalEpisodes: true, type: true, durationMin: true },
      })
    : [];
  const catById = new Map(catalog.map((c) => [c.malId, c]));

  const items = latest.map((r) => {
    const c = catById.get(r.malId);
    const duration = r.duration || 0;
    return {
      malId: r.malId,
      title: c?.title ?? r.title ?? "Unknown title",
      image: c?.image ?? r.image ?? null,
      banner: c?.banner ?? null,
      totalEpisodes: c?.totalEpisodes ?? 0,
      type: c?.type ?? null,
      durationMin: c?.durationMin ?? null,
      episode: r.episode,
      lang: r.lang === "dub" ? "dub" : "sub",
      server: r.server === "kiwi" ? "kiwi" : "zoko",
      position: r.position,
      duration,
      percent: duration > 0 ? Math.min(100, Math.round((r.position / duration) * 100)) : 0,
      completed: r.completed,
      updatedAt: r.updatedAt.toISOString(),
    };
  });

  return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } });
}
