import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Anime comments — with likes and one level of replies.
 *
 * GET    /api/comments?malId=<id>&userId=<me>  -> flat list (top-level + replies),
 *                                                 each with `likes`, `likedByMe`,
 *                                                 `parentId` (client builds the tree)
 * POST   /api/comments { malId, userId, nickname, avatar?, text, parentId? }
 * DELETE /api/comments { id, userId }          -> author-only delete (also drops replies)
 */

type CommentRow = {
  id: string;
  nickname: string;
  avatar: string | null;
  text: string;
  createdAt: Date;
  userId: string;
  parentId: string | null;
  likedBy: string;
};

function decorate(c: CommentRow, me: string | null) {
  let liked: string[] = [];
  try {
    liked = JSON.parse(c.likedBy || "[]") as string[];
    if (!Array.isArray(liked)) liked = [];
  } catch {
    liked = [];
  }
  return {
    id: c.id,
    nickname: c.nickname,
    avatar: c.avatar,
    text: c.text,
    createdAt: c.createdAt.toISOString(),
    userId: c.userId,
    parentId: c.parentId,
    likes: liked.length,
    likedByMe: me ? liked.includes(me) : false,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const malId = parseInt(url.searchParams.get("malId") ?? "", 10);
  const me = (url.searchParams.get("userId") ?? "").trim() || null;
  if (!Number.isFinite(malId)) {
    return NextResponse.json({ comments: [] }, { status: 400 });
  }

  const comments = await db.comment.findMany({
    where: { malId },
    orderBy: { createdAt: "desc" },
    take: 300,
    select: {
      id: true,
      nickname: true,
      avatar: true,
      text: true,
      createdAt: true,
      userId: true,
      parentId: true,
      likedBy: true,
    },
  });

  return NextResponse.json(
    { comments: comments.map((c) => decorate(c, me)) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  let body: {
    malId?: number;
    userId?: string;
    nickname?: string;
    avatar?: string | null;
    text?: string;
    parentId?: string | null;
  };
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

  // Replies are one level deep: replying to a reply attaches to the root instead.
  let parentId: string | null = null;
  const rawParent = (body.parentId ?? "").trim();
  if (rawParent) {
    const parent = await db.comment.findUnique({ where: { id: rawParent } });
    if (!parent || parent.malId !== malId) {
      return NextResponse.json({ error: "parent not found" }, { status: 400 });
    }
    parentId = parent.parentId ?? parent.id; // flatten replies-of-replies to the root
  }

  // make sure the author exists (progress POSTs usually already created it)
  await db.user.upsert({ where: { id: userId }, update: {}, create: { id: userId, nickname, avatar } });

  const comment = await db.comment.create({
    data: { malId, userId, nickname, avatar, text, parentId },
    select: {
      id: true,
      nickname: true,
      avatar: true,
      text: true,
      createdAt: true,
      userId: true,
      parentId: true,
      likedBy: true,
    },
  });

  return NextResponse.json(
    { comment: decorate(comment, userId) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE(req: Request) {
  let body: { id?: string; userId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const id = (body.id ?? "").trim();
  const userId = (body.userId ?? "").trim();
  if (!id || !userId) {
    return NextResponse.json({ error: "bad params" }, { status: 400 });
  }

  const comment = await db.comment.findUnique({ where: { id } });
  if (!comment) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (comment.userId !== userId) {
    return NextResponse.json({ error: "not yours" }, { status: 403 });
  }

  // drop the comment and (in one query set) any replies hanging off it
  await db.comment.deleteMany({ where: { OR: [{ id }, { parentId: id }] } });
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
