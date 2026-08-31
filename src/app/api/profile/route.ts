import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Viewer profile — no passwords. The client generates a UUID kept in
 * localStorage and syncs nickname + avatar here so comments (and any future
 * cross-device session) can show who you are.
 *
 * GET  /api/profile?userId=<uuid>   -> { id, nickname, avatar } | { user: null }
 * POST /api/profile { userId, nickname, avatar } -> upserted profile
 */
export async function GET(req: Request) {
  const userId = new URL(req.url).searchParams.get("userId");
  if (!userId) return NextResponse.json({ user: null }, { status: 400 });

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, nickname: true, avatar: true },
  });
  return NextResponse.json({ user }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  let body: { userId?: string; nickname?: string; avatar?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const userId = (body.userId ?? "").trim();
  if (!userId || userId.length > 64) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  // nickname: 1-24 visible chars, collapsed whitespace
  const nickname = (body.nickname ?? "Otaku")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24) || "Otaku";

  // avatar: small data URL only (client resizes to 160x160 JPEG, ~15-40 KB)
  let avatar: string | null = null;
  if (typeof body.avatar === "string" && body.avatar.startsWith("data:image/")) {
    avatar = body.avatar.length <= 400_000 ? body.avatar : null;
    if (!avatar) return NextResponse.json({ error: "avatar too large" }, { status: 413 });
  }

  const user = await db.user.upsert({
    where: { id: userId },
    update: { nickname, ...(body.avatar !== undefined ? { avatar } : {}) },
    create: { id: userId, nickname, avatar },
    select: { id: true, nickname: true, avatar: true },
  });

  return NextResponse.json({ user }, { headers: { "Cache-Control": "no-store" } });
}
