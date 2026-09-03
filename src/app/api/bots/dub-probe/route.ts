import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { probeDubChainEp, recordProbeResult, type DubChain } from "@/lib/dub-boundary";

export const dynamic = "force-dynamic";
// a chain probe resolves up to 4 sources (pages + segment compares)
export const maxDuration = 60;

/**
 * GET /api/bots/dub-probe?token=T&malId=X&ep=N&chain=s1|s2
 *
 * One step of the fleet's per-episode dub boundary search. The probe
 * LITERALLY clicks the DUB server: it runs the exact resolution chain the
 * player's DUB button runs (Zoko -> Kiwi -> SupaPlay -> Megaplay for s1;
 * Kiwi -> Zoko -> Megaplay for s2), including the fake-dub segment
 * verification — so a `false` verdict is PROOF the dub isn't there for that
 * episode, never a sub-detection error (the Elbaph case: the anime has dub
 * servers, but the current arc's episodes were never dubbed).
 *
 *   verdict true  — a real English dub is served
 *   verdict false — every source definitively lacks one for this episode
 *   verdict null  — transient network trouble; nothing recorded, retry later
 *
 * Definitive verdicts are recorded into DubProbe + the anime's monotonic
 * boundary columns (dubThruS1/S2, dubHiS1/S2) and returned to the bot.
 */
const TOKEN = process.env.SCOUT_TOKEN ?? "clyle-scout-v1";

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  if (sp.get("token") !== TOKEN) return NextResponse.json({ error: "bad token" }, { status: 401 });
  const malId = parseInt(sp.get("malId") ?? "", 10);
  const ep = parseInt(sp.get("ep") ?? "", 10);
  const chain: DubChain = sp.get("chain") === "s2" ? "s2" : "s1";
  if (!Number.isFinite(malId) || malId <= 0 || !Number.isFinite(ep) || ep < 1) {
    return NextResponse.json({ error: "bad params" }, { status: 400 });
  }

  try {
    const anime = await db.anime.findUnique({
      where: { malId },
      select: { title: true, totalEpisodes: true },
    });
    if (!anime) return NextResponse.json({ error: "unknown anime" }, { status: 404 });

    const verdict = await probeDubChainEp(malId, ep, chain);
    if (verdict === null) {
      return NextResponse.json({ ok: true, verdict: null, detail: "transient — nothing recorded" }, { headers: { "Cache-Control": "no-store" } });
    }
    await recordProbeResult(malId, ep, chain, verdict, null, "fleet dubprobe");
    const after = await db.anime.findUnique({
      where: { malId },
      select: { dubThruS1: true, dubThruS2: true },
    });
    return NextResponse.json(
      {
        ok: true,
        malId,
        ep,
        chain,
        title: anime.title,
        verdict,
        boundaries: { s1: after?.dubThruS1 ?? null, s2: after?.dubThruS2 ?? null },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err).slice(0, 300) }, { status: 500 });
  }
}
