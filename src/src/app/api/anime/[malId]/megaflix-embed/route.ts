import { NextResponse } from "next/server";
import { megaflixUrlForMal, verifyMegaflixEmbed } from "@/lib/megaflix";

export const dynamic = "force-dynamic";
// cold verdict = one upstream fetch (the embed page) after the id mapping
export const maxDuration = 30;

/**
 * GET /api/anime/:malId/megaflix-embed?ep=N&lang=dub
 *   ->  { ok: boolean | null, url?: string }
 *
 * Pre-flight for the MegaFlix embed server (megaflix.buzz — AniList-keyed,
 * SUB + DUB routes). Their edge serves a "Netherlands network endpoint"
 * placeholder to every non-NL vantage we can test from, so `ok` is
 * definitive about THAT: false = the walk chain skips MegaFlix instead of
 * stranding the viewer on a dead embed; true = real HTML came back (embed
 * shown); null = network trouble — stay optimistic. `url` is the resolved
 * AniList-keyed embed page for the iframe.
 */
export async function GET(req: Request, { params }: { params: Promise<{ malId: string }> }) {
  const sp = new URL(req.url).searchParams;
  const { malId: malIdStr } = await params;
  const malId = parseInt(malIdStr, 10);
  const ep = parseInt(sp.get("ep") ?? "", 10);
  const lang = sp.get("lang") === "sub" ? "sub" : "dub";
  if (!Number.isFinite(malId) || malId <= 0 || !Number.isFinite(ep) || ep <= 0) {
    return NextResponse.json({ error: "bad params" }, { status: 400 });
  }
  const fresh = sp.get("fresh") === "1";
  const [ok, url] = await Promise.all([
    verifyMegaflixEmbed(malId, ep, lang, { fresh }).catch(() => null),
    megaflixUrlForMal(malId, ep, lang).catch(() => null),
  ]);
  return NextResponse.json(
    { ok, ...(url ? { url } : {}) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
