import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sessionFromRequest } from "@/lib/auth";
import { rateLimit, clientIp } from "@/lib/guard";

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

/**
 * Identity resolution — the server never trusts a client-claimed identity
 * for google: users. A valid session cookie owns its google:<sub> id
 * (nickname/avatar come from the session, not the body); anonymous devices
 * keep their localStorage uuid. Returns null when a body tries to forge a
 * google identity without the matching session.
 */
function identityFrom(
  req: Request,
  bodyUserId: string,
): { id: string; nickname: string | null; avatar: string | null } | null {
  const session = sessionFromRequest(req);
  if (session) return { id: session.id, nickname: session.nickname, avatar: session.avatar };
  if (bodyUserId.startsWith("google:")) return null; // forgery attempt
  return { id: bodyUserId, nickname: null, avatar: null };
}

/** Avatar sanitizer: small data URL or an https picture URL. */
function sanitizeAvatar(avatar: unknown): string | null {
  if (typeof avatar !== "string") return null;
  if (avatar.startsWith("data:image/") && avatar.length <= 400_000) return avatar;
  if (avatar.startsWith("https://") && avatar.length <= 2_000) return avatar;
  return null;
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
  const text = (body.text ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  const fallbackNickname = (body.nickname ?? "Username").replace(/\s+/g, " ").trim().slice(0, 24) || "Username";
  const avatar = sanitizeAvatar(body.avatar);

  // isInteger — fractional malId blows up the Int-column create as a raw 500
  if (!Number.isInteger(malId) || !body.userId?.trim() || !text) {
    return NextResponse.json({ error: "bad params" }, { status: 400 });
  }

  const identity = identityFrom(req, body.userId.trim());
  if (!identity) {
    return NextResponse.json({ error: "sign in to post as this identity" }, { status: 403 });
  }
  const userId = identity.id;
  // spam gate: 8 posts / minute per identity+ip (per instance)
  if (!rateLimit(`cmt:${userId}:${clientIp(req)}`, 8, 60_000)) {
    return NextResponse.json({ error: "slow down" }, { status: 429 });
  }
  const nickname = identity.nickname ?? fallbackNickname;
  const finalAvatar = identity.avatar ?? avatar;

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
  await db.user.upsert({ where: { id: userId }, update: {}, create: { id: userId, nickname, avatar: finalAvatar } });

  const comment = await db.comment.create({
    data: { malId, userId, nickname, avatar: finalAvatar, text, parentId },
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
  if (!rateLimit(`cmt-del:${clientIp(req)}`, 20, 60_000)) {
    return NextResponse.json({ error: "slow down" }, { status: 429 });
  }

  const comment = await db.comment.findUnique({ where: { id } });
  if (!comment) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // author-only delete: google: authors must prove the session; device ids
  // match on the body uuid (which cannot be a google: id — see identityFrom)
  const session = sessionFromRequest(req);
  const claimed = session?.id ?? (userId.startsWith("google:") ? null : userId);
  if (!claimed || comment.userId !== claimed) {
    return NextResponse.json({ error: "not yours" }, { status: 403 });
  }

  // drop the comment and (in one query set) any replies hanging off it,
  // tombstoning every removed id so the deploy carry-forward never
  // resurrects them from an older bundled db
  const doomed = await db.comment.findMany({
    where: { OR: [{ id }, { parentId: id }] },
    select: { id: true },
  });
  await db.comment.deleteMany({ where: { OR: [{ id }, { parentId: id }] } });
  for (const d of doomed) {
    await db.deletedComment.create({ data: { id: d.id } }).catch(() => undefined);
  }
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
