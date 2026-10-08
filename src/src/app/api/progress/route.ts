import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Precise per-episode watch progress (seconds watched / total seconds).
 *
 * POST   /api/progress { userId, malId, title?, image?, episode, lang, server,
 *                        position, duration, completed?, resume? }  -> upsert
 * GET    /api/progress?userId=&malId=  -> per-episode bars for one anime
 * DELETE /api/progress?userId=&malId=  -> forget an anime (remove from Continue)
 *
 * Removal is TOMBSTONED: progress saves race the DELETE from many directions
 * (10s heartbeats, page-hide beacons, unmount flushes, cast heartbeats,
 * another tab) and any save landing after the delete re-inserted the row —
 * "I removed it from Continue Watching but it came back". The tombstone
 * (RemovedProgress) blocks every stale save until the viewer deliberately
 * plays the anime again (POST with resume: true clears it).
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
  resume?: boolean; // deliberate playback — clears a removal tombstone
  updatedAt?: string; // merge path: the source row's timestamp (newer-wins)
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

  // userId cap mirrors /api/profile; malId must be an Int (the Prisma column
  // is Int — a fractional value used to blow up in the upsert as a raw 500)
  if (!userId || userId.length > 64 || !Number.isInteger(malId)) {
    return NextResponse.json({ error: "bad params" }, { status: 400 });
  }

  // deliberate playback lifts the removal tombstone. Works as a PURE clear
  // (WatchView mounting for an anime the user had removed — no progress
  // payload yet) and also alongside a normal save.
  if (b.resume) {
    await db.removedProgress.deleteMany({ where: { userId, malId } }).catch(() => undefined);
    if (!Number.isFinite(episode) || !Number.isFinite(position)) {
      return NextResponse.json({ ok: true, cleared: true }, { headers: { "Cache-Control": "no-store" } });
    }
  }

  if (!Number.isInteger(episode) || !Number.isFinite(position)) {
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

  // (non-resume saves) a tombstoned anime stays removed: drop stale
  // heartbeats/beacons instead of resurrecting the row
  if (!b.resume) {
    const tombstoned = await db.removedProgress.findUnique({
      where: { userId_malId: { userId, malId } },
      select: { userId: true },
    });
    if (tombstoned) return NextResponse.json({ ok: true, skipped: "removed" }, { headers: { "Cache-Control": "no-store" } });
  }

  // the User row must exist first (WatchProgress.userId is a foreign key to it)
  await db.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

  // NEWER-WINS: the sign-in merge re-POSTs rows copied from another device —
  // a blind upsert let OLD device rows clobber NEWER account rows. When the
  // body carries an explicit timestamp (the merge path does), an existing
  // row newer than it stays untouched.
  const incomingAt = typeof b.updatedAt === "string" ? Date.parse(b.updatedAt) : NaN;
  if (Number.isFinite(incomingAt)) {
    const existing = await db.watchProgress.findUnique({
      where: { userId_malId_episode: { userId, malId, episode } },
      select: { updatedAt: true },
    });
    if (existing && existing.updatedAt.getTime() > incomingAt + 1_000) {
      return NextResponse.json({ ok: true, skipped: "newer" }, { headers: { "Cache-Control": "no-store" } });
    }
  }

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

  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(req: Request) {
  const sp = new URL(req.url).searchParams;
  const userId = sp.get("userId");
  if (!userId) {
    return NextResponse.json({ error: "bad params" }, { status: 400 });
  }
  if (sp.get("all") === "1") {
    // full history wipe (Settings → Clear watch history): EVERY progress row
    // — /api/continue only surfaces the uncompleted ones, so the per-item
    // path left fully-watched shows behind — plus this device's tombstones
    await db.watchProgress.deleteMany({ where: { userId } });
    await db.removedProgress.deleteMany({ where: { userId } });
    return NextResponse.json({ ok: true, wiped: true });
  }
  const malId = parseInt(sp.get("malId") ?? "", 10);
  if (!Number.isFinite(malId)) {
    return NextResponse.json({ error: "bad params" }, { status: 400 });
  }
  await db.watchProgress.deleteMany({ where: { userId, malId } });
  // tombstone the removal: every late save (beacon, heartbeat, other tab)
  // is now rejected until the viewer plays the anime again
  await db.removedProgress
    .upsert({ where: { userId_malId: { userId, malId } }, update: { removedAt: new Date() }, create: { userId, malId } })
    .catch(() => undefined);
  return NextResponse.json({ ok: true });
}
