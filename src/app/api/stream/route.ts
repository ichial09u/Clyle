import { NextResponse } from "next/server";
import { resolveStream } from "@/lib/zoko-stream";
import { withSkipDataLive } from "@/lib/skip-times";
import { db } from "@/lib/db";
import type { Lang, ServerId } from "@/lib/zoko";

export const dynamic = "force-dynamic";
// fake-dub verification (sub-vs-dub segment compare) can take a while cold
export const maxDuration = 60;

/**
 * GET /api/stream?malId=21&ep=1&lang=sub&server=zoko
 *
 * Resolves one episode's direct HLS playlist + subtitle tracks + skip data
 * from Zoko, so our own player can stream it without Zoko's ad-laden page.
 *
 * DUB requests fall back across servers: if the requested server has no real
 * dub for this anime/episode, the other server is tried ("if Zoko doesn't
 * have it, show Kiwi's server"). The response's `serverUsed` reports which
 * server actually served the stream (equal to the requested one unless the
 * fallback kicked in).
 */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const malId = parseInt(sp.get("malId") ?? "", 10);
  const ep = parseInt(sp.get("ep") ?? "", 10);
  const lang: Lang = sp.get("lang") === "dub" ? "dub" : "sub";
  const server: ServerId = sp.get("server") === "kiwi" ? "kiwi" : "zoko";
  const fresh = sp.get("fresh") === "1";

  if (!Number.isFinite(malId) || malId <= 0 || !Number.isFinite(ep) || ep <= 0) {
    return NextResponse.json({ error: "bad params" }, { status: 400 });
  }

  let serverUsed: ServerId = server;
  let stream = await resolveStream(malId, ep, lang, server, { fresh });
  if (!stream && lang === "dub") {
    // requested server has no real dub here — try the other one
    const other: ServerId = server === "kiwi" ? "zoko" : "kiwi";
    const alt = await resolveStream(malId, ep, lang, other, { fresh });
    if (alt) {
      stream = alt;
      serverUsed = other;
    }
  }
  if (!stream) {
    return NextResponse.json({ error: "stream unavailable" }, { status: 404 });
  }
  // enrich Zoko's sparse skip data (OP/ED timings) with the vendored AniSkip
  // dataset + a cached live AniSkip query for brand-new/uncovered episodes
  // (the live query wants the episode's length in minutes for its filters)
  const meta = await db.anime.findUnique({ where: { malId }, select: { durationMin: true } });
  const enriched = await withSkipDataLive(malId, ep, stream, { episodeLengthMin: meta?.durationMin });
  return NextResponse.json({ ...enriched, serverUsed }, {
    headers: { "Cache-Control": "no-store" },
  });
}
