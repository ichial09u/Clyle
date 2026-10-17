import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { harvest, logAnnSub } from "@/lib/global-log";

/**
 * ANN tracking subscriptions — the server half of the tracking button's
 * switch (separate route because a Next.js route file allows ONE handler per
 * HTTP method and /api/ann-track's GET serves the encyclopedia lookup).
 *
 * The per-device ON/OFF state lives in localStorage, but the hourly ANN news
 * sweep (/api/ann-news) needs the (endpoint, anime) pairs GLOBALLY, so
 * toggles are applied locally AND published to the global log (which
 * converges every instance's AnnTrackSub + PushSub tables). Push keys ride
 * along so instances that never saw the original subscribe call can still
 * encrypt to this device.
 *
 * GET  /api/ann-track/subs?endpoint=<push endpoint> -> { anns: [...] }
 * POST /api/ann-track/subs { endpoint, keys:{p256dh,auth}, ann:{...}, on } -> { ok }
 */
export const dynamic = "force-dynamic";

type SubBody = {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
  ann?: { malId?: number; annId?: number | null; annName?: string | null; title?: string | null; image?: string | null };
  on?: boolean;
};

export async function POST(req: Request) {
  let b: SubBody;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const endpoint = b.endpoint ?? "";
  const p256dh = b.keys?.p256dh ?? "";
  const auth = b.keys?.auth ?? "";
  const malId = Number(b.ann?.malId);
  // isInteger — fractional malId blows up the Int-column upsert as a raw 500
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth || !Number.isInteger(malId) || malId <= 0) {
    return NextResponse.json({ ok: false, error: "endpoint, keys and ann.malId required" }, { status: 400 });
  }
  const ann = {
    malId,
    annId: Number.isFinite(Number(b.ann?.annId)) ? Number(b.ann?.annId) : null,
    annName: (b.ann?.annName ?? "").slice(0, 200) || null,
    title: (b.ann?.title ?? "").slice(0, 200) || null,
    image: (b.ann?.image ?? "").slice(0, 2000) || null,
  };
  const on = b.on !== false;

  if (on) {
    await db.pushSub
      .upsert({ where: { endpoint }, create: { endpoint, p256dh, auth }, update: { p256dh, auth } })
      .catch(() => undefined);
    await db.annTrackSub.upsert({
      where: { endpoint_malId: { endpoint, malId } },
      create: { endpoint, malId, annId: ann.annId, annName: ann.annName, title: ann.title, image: ann.image },
      update: { annId: ann.annId, annName: ann.annName, title: ann.title, image: ann.image },
    });
  } else {
    await db.annTrackSub.deleteMany({ where: { endpoint, malId } });
  }

  // converge: every other instance applies the same change
  logAnnSub(endpoint, { p256dh, auth }, ann, on);

  return NextResponse.json({ ok: true, on }, { headers: { "Cache-Control": "no-store" } });
}

/** This device's tracked anime list (server truth, converged globally). */
export async function GET(req: Request) {
  const endpoint = new URL(req.url).searchParams.get("endpoint");
  if (!endpoint || !/^https:\/\//.test(endpoint)) {
    return NextResponse.json({ anns: [] }, { headers: { "Cache-Control": "no-store" } });
  }
  await harvest(); // pick up toggles made on other instances
  const rows = await db.annTrackSub.findMany({
    where: { endpoint },
    select: { malId: true, annId: true, annName: true, title: true, image: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return NextResponse.json({ anns: rows }, { headers: { "Cache-Control": "no-store" } });
}
