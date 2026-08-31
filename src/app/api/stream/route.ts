import { NextResponse } from "next/server";
import { resolveStream } from "@/lib/zoko-stream";
import type { Lang, ServerId } from "@/lib/zoko";

export const dynamic = "force-dynamic";

/**
 * GET /api/stream?malId=21&ep=1&lang=sub&server=zoko
 *
 * Resolves one episode's direct HLS playlist + subtitle tracks + skip data
 * from Zoko, so our own player can stream it without Zoko's ad-laden page.
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

  const stream = await resolveStream(malId, ep, lang, server, { fresh });
  if (!stream) {
    return NextResponse.json({ error: "stream unavailable" }, { status: 404 });
  }
  return NextResponse.json(stream, {
    headers: { "Cache-Control": "no-store" },
  });
}
