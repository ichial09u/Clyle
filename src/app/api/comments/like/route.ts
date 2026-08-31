import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * POST /api/comments/like { commentId, userId } — toggle this user's like.
 *
 * likedBy is a JSON array of userIds on the comment row, so the count is the
 * array length and a double-like per identity is impossible (toggle semantics).
 * Works on replies too.
 */
export async function POST(req: Request) {
  let body: { commentId?: string; userId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const commentId = (body.commentId ?? "").trim();
  const userId = (body.userId ?? "").trim();
  if (!commentId || !userId) {
    return NextResponse.json({ error: "bad params" }, { status: 400 });
  }

  const comment = await db.comment.findUnique({ where: { id: commentId } });
  if (!comment) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let liked: string[] = [];
  try {
    liked = JSON.parse(comment.likedBy || "[]") as string[];
    if (!Array.isArray(liked)) liked = [];
  } catch {
    liked = [];
  }

  const had = liked.includes(userId);
  const next = had ? liked.filter((u) => u !== userId) : [...liked, userId].slice(-500);

  await db.comment.update({ where: { id: commentId }, data: { likedBy: JSON.stringify(next) } });

  return NextResponse.json(
    { ok: true, liked: !had, likes: next.length },
    { headers: { "Cache-Control": "no-store" } },
  );
}
