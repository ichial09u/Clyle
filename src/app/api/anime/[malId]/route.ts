import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { jikan, jikanOne, type JikanAnime } from "@/lib/jikan";
import { anilistToJikan, mediaByMal, relationName } from "@/lib/anilist";
import { upsertAnime } from "@/lib/sync";
import { lite } from "@/lib/serialize";

export const dynamic = "force-dynamic";

const SEASON_RELATIONS = ["Sequel", "Prequel", "Side story", "Summary", "Alternative version", "Parent story"];

/**
 * GET /api/anime/{malId} — full details + Other Seasons + You May Also Like.
 *
 * AniList-first: relations and recommendations arrive in the SAME request as
 * the details (previously two Jikan calls that could retry through MAL 504s
 * for 10+ seconds). Jikan stays as the fallback source.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ malId: string }> }) {
  const { malId: malIdStr } = await params;
  const malId = parseInt(malIdStr, 10);
  if (!Number.isFinite(malId)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  let row = await db.anime.findUnique({ where: { malId } });

  // fetch from AniList if we have never seen this anime (Jikan fallback)
  if (!row) {
    const media = await mediaByMal(malId);
    const conv = media ? anilistToJikan(media) : null;
    if (conv) {
      await upsertAnime(conv, { inCatalog: false, source: "lookup" });
    } else {
      const full = await jikanOne<JikanAnime>(`/anime/${malId}/full`);
      if (!full) return NextResponse.json({ error: "not found" }, { status: 404 });
      await upsertAnime(full, { inCatalog: false, source: "lookup" });
    }
    row = await db.anime.findUnique({ where: { malId } });
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const anime = lite(row);

  // One AniList request carries relations + recommendations (disk-cached 6h)
  const media = await mediaByMal(malId);

  // ---- Other Seasons (Sequel / Prequel / Side story / Summary / …) ----
  const otherSeasons: Array<{ malId: number; name: string; relation: string; image: string | null; inCatalog: boolean }> = [];

  const pushRelated = async (rel: string, malId2: number, name: string, image: string | null) => {
    const relRow = await db.anime.findUnique({ where: { malId: malId2 }, select: { image: true, inCatalog: true } });
    otherSeasons.push({ malId: malId2, name, relation: rel, image: relRow?.image ?? image, inCatalog: relRow?.inCatalog ?? false });
  };

  if (media?.relations?.edges?.length) {
    for (const edge of media.relations.edges) {
      const rel = relationName(edge.relationType);
      if (!SEASON_RELATIONS.includes(rel)) continue;
      const node = edge.node;
      const relatedMal = node?.idMal ?? null;
      if (!node || !relatedMal) continue;
      await pushRelated(rel, relatedMal, node.title?.english ?? node.title?.romaji ?? `#${relatedMal}`, node.coverImage?.extraLarge ?? node.coverImage?.large ?? null);
    }
  } else {
    // Jikan fallback for the relations graph
    const full = await jikanOne<JikanAnime>(`/anime/${malId}/full`);
    const relations = (row.inCatalog ? full?.relations : []) ?? [];
    for (const rel of relations) {
      if (!SEASON_RELATIONS.includes(rel.relation)) continue;
      for (const e of rel.entry) {
        if (e.type !== "anime") continue;
        await pushRelated(rel.relation, e.mal_id, e.name, null);
      }
    }
  }

  // ---- You May Also Like — recommendations, catalog entries first ----
  let similar: Array<{ malId: number; name: string; image: string | null; inCatalog: boolean }> = [];

  if (media?.recommendations?.nodes?.length) {
    const recs = media.recommendations.nodes
      .map((n) => n.mediaRecommendation)
      .filter((m): m is NonNullable<typeof m> => !!m)
      .map(anilistToJikan)
      .filter((a): a is JikanAnime => !!a)
      .slice(0, 24);
    similar = await buildSimilar(recs);
  } else {
    // Jikan fallback
    const recs = await jikan<{ data: Array<{ entry: JikanAnime }> }>(`/anime/${malId}/recommendations`);
    const recEntries = (recs?.data ?? []).map((r) => r.entry).slice(0, 24);
    similar = await buildSimilar(recEntries);
  }

  async function buildSimilar(recEntries: JikanAnime[]) {
    const recRows = await Promise.all(
      recEntries.map((e) => db.anime.findUnique({ where: { malId: e.mal_id }, select: { image: true, inCatalog: true } })),
    );
    const list = recEntries.map((e, i) => ({
      malId: e.mal_id,
      name: e.title_english ?? e.title,
      image: recRows[i]?.image ?? e.images?.webp?.large_image_url ?? e.images?.jpg?.large_image_url ?? e.images?.jpg?.image_url ?? null,
      inCatalog: recRows[i]?.inCatalog ?? false,
    }));
    list.sort((a, b) => Number(b.inCatalog) - Number(a.inCatalog));
    return list;
  }

  return NextResponse.json({ anime, otherSeasons: otherSeasons.slice(0, 12), similar: similar.slice(0, 12) });
}
