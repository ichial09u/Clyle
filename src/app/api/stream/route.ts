import { NextResponse } from "next/server";
import { resolveStream } from "@/lib/zoko-stream";
import { megaplayDub, verifyRealMegaplayDub } from "@/lib/megaplay";
import { supaplayDub } from "@/lib/supaplay";
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
 * DUB fallback chain (missing-dub backfill):
 *   1. the requested server (Zoko/Kiwi — verdict-gated real dubs)
 *   2. the other server ("if Zoko doesn't have it, show Kiwi's server")
 *   3. SupaPlay — ONLY when Server #1 was requested (its DUB source; needs
 *      an Anime.supaplayPath mapping)
 *   4. Megaplay (yenime's api.flikhub.net backend) — Server #2's DUB source,
 *      and the final backfill for Server #1 when SupaPlay is unmapped.
 * All backfill sources are DUB ONLY — SUB always flows through Zoko/Kiwi.
 * The response's `serverUsed` keeps reporting Zoko/Kiwi (or the requested
 * server for backfill hits); `provider` names the actual source.
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
  let provider: "zoko" | "kiwi" | "supaplay" | "yenime" = server;
  let stream = await resolveStream(malId, ep, lang, server, { fresh });
  if (!stream && lang === "dub") {
    // requested server has no real dub here — try the other one
    const other: ServerId = server === "kiwi" ? "zoko" : "kiwi";
    const alt = await resolveStream(malId, ep, lang, other, { fresh });
    if (alt) {
      stream = alt;
      serverUsed = other;
      provider = other;
    }
  }
  if (!stream && lang === "dub") {
    // Server #1's DUB backfill source first (SupaPlay, dub only) — skipped
    // for Server #2 requests, which belong to yenime per the server mapping
    if (server === "zoko") {
      const supa = await supaplayDub(malId, ep, { fresh });
      if (supa) {
        stream = { src: supa.src, subtitles: supa.subtitles, resolvedFrom: supa.resolvedFrom };
        provider = "supaplay";
      }
    }
  }
  if (!stream && lang === "dub") {
    // Server #2's DUB backfill source — Megaplay/yenime (HLS, dub only).
    // The 24h-cached verdict keeps megaplay's ad-stub fake dubs out; a
    // transient "couldn't check" (null) never blocks playback.
    const megaVerdict = await verifyRealMegaplayDub(malId, ep);
    if (megaVerdict !== false) {
      const mega = await megaplayDub(malId, ep, { fresh });
      if (mega) {
        stream = { src: mega.src, subtitles: mega.subtitles, resolvedFrom: mega.resolvedFrom };
        provider = "yenime";
      }
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
  return NextResponse.json({ ...enriched, serverUsed, provider }, {
    headers: { "Cache-Control": "no-store" },
  });
}
