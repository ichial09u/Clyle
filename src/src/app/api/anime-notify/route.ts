import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { logAnimeNotify } from "@/lib/global-log";

export const dynamic = "force-dynamic";

/**
 * Per-anime episode watches — "notify me about the NEXT episode of THIS anime
 * only" (the bell on the details page, managed from Settings -> Notifications).
 *
 * One AnimeNotify row per (device endpoint, anime). Episode-drop pushes and
 * the daily airing-soon reminder go only to devices that opted in for that
 * anime (see push.ts); new-series/Top 10 pushes stay broadcast.
 *
 * GET  /api/anime-notify?endpoint=<push endpoint url>  -> { malIds: number[], items: [...] }
 * POST /api/anime-notify { endpoint, malId, title?, image?, on: boolean }
 *      -> upserts or removes the (endpoint, malId) row
 */
export async function GET(req: Request) {
  const endpoint = new URL(req.url).searchParams.get("endpoint");
  if (!endpoint || !/^https:\/\//.test(endpoint)) {
    return NextResponse.json({ malIds: [], items: [] }, { headers: { "Cache-Control": "no-store" } });
  }
  const rows = await db.animeNotify.findMany({
    where: { endpoint },
    select: { malId: true, title: true, image: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return NextResponse.json(
    { malIds: rows.map((r) => r.malId), items: rows },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  let body: { endpoint?: string; malId?: number; title?: string | null; image?: string | null; on?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const endpoint = body.endpoint;
  const malId = Number(body.malId);
  if (!endpoint || !/^https:\/\//.test(endpoint) || !Number.isInteger(malId) || malId <= 0) {
    return NextResponse.json({ ok: false, error: "endpoint and malId required" }, { status: 400 });
  }

  if (body.on === false) {
    await db.animeNotify.deleteMany({ where: { endpoint, malId } });
    // converge fleet-wide — the off toggle used to be invisible to other
    // instances, so their airing-soon sweeps kept ringing a switched-off bell
    logAnimeNotify(endpoint, malId, null, null, false);
    return NextResponse.json({ ok: true, on: false });
  }

  // type-safe fields: a non-string title used to TypeError on .slice(), an
  // oversized image row used to be stored unchecked (ann-track/subs caps 2000)
  const title = typeof body.title === "string" ? body.title.slice(0, 200) || null : null;
  const image = typeof body.image === "string" && body.image.length <= 2000 ? body.image : null;
  const row = await db.animeNotify.upsert({
    where: { endpoint_malId: { endpoint, malId } },
    create: { endpoint, malId, title, image },
    update: { title, image },
  });
  logAnimeNotify(endpoint, malId, title, image, true);
  return NextResponse.json({ ok: true, on: true, id: row.id });
}
