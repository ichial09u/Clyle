import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Anime comments.
 *
 * GET  /api/comments?malId=<id>  -> newest 100 comments
 * POST /api/comments { malId, userId, nickname, avatar?, text }
 */
export async function GET(req: Request) {
  const malId = parseInt(new URL(req.url).searchParams.get("malId") ?? "", 10);
  if (!Number.isFinite(malId)) {
    return NextResponse.json({ comments: [] }, { status: 400 });
  }

  const comments = await db.comment.findMany({
    where: { malId },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, nickname: true, avatar: true, text: true, createdAt: true, userId: true },
  });

  return NextResponse.json(
    { comments: comments.map((c) => ({ ...c, createdAt: c.createdAt.toISOString() })) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  let body: { malId?: number; userId?: string; nickname?: string; avatar?: string | null; text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const malId = Number(body.malId);
  const userId = (body.userId ?? "").trim();
  const text = (body.text ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  const nickname = (body.nickname ?? "Otaku").replace(/\s+/g, " ").trim().slice(0, 24) || "Otaku";
  const avatar =
    typeof body.avatar === "string" && body.avatar.startsWith("data:image/") && body.avatar.length <= 400_000
      ? body.avatar
      : null;

  if (!Number.isFinite(malId) || !userId || !text) {
    return NextResponse.json({ error: "bad params" }, { status: 400 });
  }

  // make sure the author exists (progress POSTs usually already created it)
  await db.user.upsert({ where: { id: userId }, update: {}, create: { id: userId, nickname, avatar } });

  const comment = await db.comment.create({
    data: { malId, userId, nickname, avatar, text },
    select: { id: true, nickname: true, avatar: true, text: true, createdAt: true, userId: true },
  });

  return NextResponse.json(
    { comment: { ...comment, createdAt: comment.createdAt.toISOString() } },
    { headers: { "Cache-Control": "no-store" } },
  );
}
