import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { jikan, jikanOne, type JikanAnime } from "@/lib/jikan";
import { upsertAnime } from "@/lib/sync";
import { lite } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/** GET /api/anime/{malId} — full details + Other Seasons + You May Also Like */
export async function GET(_req: Request, { params }: { params: Promise<{ malId: string }> }) {
  const { malId: malIdStr } = await params;
  const malId = parseInt(malIdStr, 10);
  if (!Number.isFinite(malId)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  let row = await db.anime.findUnique({ where: { malId } });

  // fetch from MAL if we have never seen this anime
  if (!row) {
    const full = await jikanOne<JikanAnime>(`/anime/${malId}/full`);
    if (!full) return NextResponse.json({ error: "not found" }, { status: 404 });
    await upsertAnime(full, { inCatalog: false, source: "lookup" });
    row = await db.anime.findUnique({ where: { malId } });
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const anime = lite(row);

  // Other Seasons — MAL relations (Sequel / Prequel / Side story / Summary / Alternative …)
  const full = await jikanOne<JikanAnime>(`/anime/${malId}/full`);
  const relations = (row.inCatalog ? full?.relations : []) ?? [];
  const otherSeasons: Array<{ malId: number; name: string; relation: string; image: string | null; inCatalog: boolean }> = [];
  for (const rel of relations) {
    if (!["Sequel", "Prequel", "Side story", "Summary", "Alternative version", "Parent story"].includes(rel.relation)) continue;
    for (const e of rel.entry) {
      if (e.type !== "anime") continue;
      const relRow = await db.anime.findUnique({ where: { malId: e.mal_id }, select: { image: true, inCatalog: true } });
      otherSeasons.push({
        malId: e.mal_id,
        name: e.name,
        relation: rel.relation,
        image: relRow?.image ?? null,
        inCatalog: relRow?.inCatalog ?? false,
      });
    }
  }

  // You May Also Like — MAL recommendations, catalog entries first
  const recs = await jikan<{ data: Array<{ entry: JikanAnime }> }>(`/anime/${malId}/recommendations`);
  const recEntries = (recs?.data ?? []).map((r) => r.entry).slice(0, 24);
  const recRows = await Promise.all(
    recEntries.map((e) => db.anime.findUnique({ where: { malId: e.mal_id }, select: { image: true, inCatalog: true } })),
  );
  const similar = recEntries.map((e, i) => ({
    malId: e.mal_id,
    name: e.title,
    image: recRows[i]?.image ?? (e.images?.webp?.large_image_url || e.images?.jpg?.image_url || null),
    inCatalog: recRows[i]?.inCatalog ?? false,
  }));
  similar.sort((a, b) => Number(b.inCatalog) - Number(a.inCatalog));

  return NextResponse.json({ anime, otherSeasons: otherSeasons.slice(0, 12), similar: similar.slice(0, 12) });
}
