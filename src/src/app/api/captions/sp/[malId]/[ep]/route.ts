import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/captions/sp/[malId]/[ep].vtt
 *
 * Vendored English closed captions for the WCO source (South Park), baked
 * into the packaged DB by scripts/sp-caption-harvest.mjs. Served as a real
 * WebVTT document so the player treats it exactly like a provider track:
 * the CC panel lists it, the CC-SYNC drift machinery (/api/captions) can
 * shift it, and offline saves can bundle it.
 *
 * Same-origin (no CORS), immutable-ish caching (content only changes when
 * a fresh harvest lands).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ malId: string; ep: string }> }) {
  const { malId: malIdStr, ep: epRaw } = await params;
  const malId = parseInt(malIdStr, 10);
  const ep = parseInt(epRaw.replace(/\.vtt$/i, ""), 10);
  if (!Number.isFinite(malId) || !Number.isFinite(ep)) {
    return NextResponse.json({ error: "bad params" }, { status: 400 });
  }
  try {
    const row = await db.spCaption.findUnique({
      where: { malId_ep: { malId, ep } },
      select: { content: true },
    });
    if (!row) return NextResponse.json({ error: "no captions" }, { status: 404 });
    return new NextResponse(row.content, {
      headers: {
        "Content-Type": "text/vtt; charset=utf-8",
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch {
    return NextResponse.json({ error: "captions unavailable" }, { status: 500 });
  }
}
