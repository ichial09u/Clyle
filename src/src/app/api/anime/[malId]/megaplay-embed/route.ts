import { NextResponse } from "next/server";
import { verifyMegaplayEmbed } from "@/lib/megaplay";

export const dynamic = "force-dynamic";
// cold verdict = 2 upstream fetches (embed page + getSources) + segment probes
export const maxDuration = 30;

/**
 * GET /api/anime/:malId/megaplay-embed?ep=N  ->  { ok: boolean | null }
 *
 * Pre-flight for the "DUB Megaplay" embed button. Megaplay's catalog rots —
 * takedowns delete files and whole shows get unmapped — and a dead embed
 * strands the viewer inside their error page (the Bleach TYBW Calamity ep 8
 * report). true/false come from verifyMegaplayEmbed (24h cached);
 * null = couldn't tell — the client stays optimistic (shows the embed).
 */
export async function GET(req: Request, { params }: { params: Promise<{ malId: string }> }) {
  const sp = new URL(req.url).searchParams;
  const { malId: malIdStr } = await params;
  const malId = parseInt(malIdStr, 10);
  const ep = parseInt(sp.get("ep") ?? "", 10);
  if (!Number.isFinite(malId) || malId <= 0 || !Number.isFinite(ep) || ep <= 0) {
    return NextResponse.json({ error: "bad params" }, { status: 400 });
  }
  const fresh = sp.get("fresh") === "1";
  const ok = await verifyMegaplayEmbed(malId, ep, { fresh }).catch(() => null);
  return NextResponse.json({ ok }, { headers: { "Cache-Control": "no-store" } });
}
