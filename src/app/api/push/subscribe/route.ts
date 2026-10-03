import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

interface SubscribeBody {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
  userId?: string;
}

/**
 * POST /api/push/subscribe — store (or refresh) the browser's push
 * subscription. Called by the client right after pushManager.subscribe()
 * AND on every app open while notifications are enabled, so a deploy that
 * resets the SQLite file self-heals on the next visit without re-prompting.
 */
export async function POST(req: Request) {
  let body: SubscribeBody;
  try {
    body = (await req.json()) as SubscribeBody;
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const endpoint = body.endpoint?.trim();
  const p256dh = body.keys?.p256dh?.trim();
  const auth = body.keys?.auth?.trim();
  if (!endpoint || !p256dh || !auth) {
    return NextResponse.json({ ok: false, error: "endpoint + keys required" }, { status: 400 });
  }
  if (endpoint.length > 2000 || p256dh.length > 400 || auth.length > 400) {
    return NextResponse.json({ ok: false, error: "implausible sizes" }, { status: 400 });
  }
  await db.pushSub.upsert({
    where: { endpoint },
    create: { endpoint, p256dh, auth, userId: body.userId ?? null },
    update: { p256dh, auth, userId: body.userId ?? null, updatedAt: new Date() },
  });
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * DELETE /api/push/subscribe — drop the subscription (toggle off / permission
 * revoked). Accepts { endpoint } JSON or ?endpoint= for broad compatibility.
 */
export async function DELETE(req: Request) {
  let endpoint = new URL(req.url).searchParams.get("endpoint");
  if (!endpoint) {
    try {
      const body = (await req.json()) as SubscribeBody;
      endpoint = body.endpoint?.trim() ?? null;
    } catch {
      /* no body — fall through */
    }
  }
  if (!endpoint) return NextResponse.json({ ok: false, error: "endpoint required" }, { status: 400 });
  await db.pushSub.deleteMany({ where: { endpoint } });
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
