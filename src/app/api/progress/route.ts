import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Precise per-episode watch progress (seconds watched / total seconds).
 *
 * POST   /api/progress { userId, malId, title?, image?, episode, lang, server,
 *                        position, duration, completed? }  -> upsert
 * GET    /api/progress?userId=&malId=  -> per-episode bars for one anime
 * DELETE /api/progress?userId=&malId=  -> forget an anime (remove from Continue)
 */
interface ProgressBody {
  userId?: string;
  malId?: number;
  title?: string;
  image?: string | null;
  episode?: number;
  lang?: string;
  server?: string;
  position?: number;
  duration?: number;
  completed?: boolean;
}

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const userId = sp.get("userId");
  const malId = parseInt(sp.get("malId") ?? "", 10);
  if (!userId || !Number.isFinite(malId)) {
    return NextResponse.json({ error: "bad params" }, { status: 400 });
  }

  const rows = await db.watchProgress.findMany({
    where: { userId, malId },
    select: {
      episode: true,
      position: true,
      duration: true,
      completed: true,
      lang: true,
      server: true,
      updatedAt: true,
    },
    orderBy: { episode: "asc" },
  });

  const episodes = rows.map((r) => ({
    episode: r.episode,
    position: r.position,
    duration: r.duration,
    percent: r.duration > 0 ? Math.min(100, Math.round((r.position / r.duration) * 100)) : r.completed ? 100 : 0,
    completed: r.completed,
    lang: r.lang,
    server: r.server,
    updatedAt: r.updatedAt.toISOString(),
  }));

  return NextResponse.json({ malId, episodes }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  let b: ProgressBody;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const userId = (b.userId ?? "").trim();
  const malId = Number(b.malId);
  const episode = Number(b.episode);
  const position = Number(b.position);
  const duration = Number(b.duration) || 0;

  if (!userId || !Number.isFinite(malId) || !Number.isFinite(episode) || !Number.isFinite(position)) {
    return NextResponse.json({ error: "bad params" }, { status: 400 });
  }
  if (position < 5) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  const completed = b.completed ?? (duration > 0 && position >= duration * 0.92);
  const lang = b.lang === "dub" ? "dub" : "sub";
  const server = b.server === "kiwi" ? "kiwi" : "zoko";
  const title = typeof b.title === "string" ? b.title.slice(0, 200) : null;
  const image = typeof b.image === "string" && b.image.length <= 2000 ? b.image : null;

  await db.watchProgress.upsert({
    where: { userId_malId_episode: { userId, malId, episode } },
    update: {
      position: Math.min(position, duration > 0 ? duration : position),
      duration,
      completed,
      lang,
      server,
      ...(title ? { title } : {}),
      ...(image ? { image } : {}),
    },
    create: {
      userId,
      malId,
      episode,
      position: Math.min(position, duration > 0 ? duration : position),
      duration,
      completed,
      lang,
      server,
      title,
      image,
    },
  });

  // keep the User row around (avatar/nickname source for comments)
  await db.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(req: Request) {
  const sp = new URL(req.url).searchParams;
  const userId = sp.get("userId");
  const malId = parseInt(sp.get("malId") ?? "", 10);
  if (!userId || !Number.isFinite(malId)) {
    return NextResponse.json({ error: "bad params" }, { status: 400 });
  }
  await db.watchProgress.deleteMany({ where: { userId, malId } });
  return NextResponse.json({ ok: true });
}
