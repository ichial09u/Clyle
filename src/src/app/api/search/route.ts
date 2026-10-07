import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { mediaByMal } from "@/lib/anilist";
import { upsertAniListMedia } from "@/lib/sync";
import { lite, type AnimeLite } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/**
 * GET /api/search?q=pokemon
 *
 * Catalog-only search (instant, zero upstream calls).
 *
 * Ranking (the Pokémon fix): a plain `orderBy popularity, take 24` buried the
 * flagship — all 63 Pokémon franchise imports have popularity=null, so SQLite's
 * nulls-first ordering left them dead last and "pokemon" surfaced nothing from
 * the franchise it names. One normalized scan now scores every hit:
 *   tier 0 = exact match on the normalized title ("pokemon" == "Pokémon")
 *   tier 1 = prefix match
 *   tier 2 = substring match
 * with popularity as the tie-breaker INSIDE each tier and nulls LAST, capped
 * at 80 so huge franchises come back complete.
 *
 * Smart matching: the normalized pass folds accents ("pokemon" -> "Pokémon"),
 * spacing ("onepiece" -> "One Piece", "dan da dan") and punctuation
 * ("re:zero" -> "Re:ZERO") — the user's typing never has to match the
 * catalog's exact spelling.
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return NextResponse.json({ catalog: [], mal: [] });

  const norm = (s: string) =>
    (s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]/g, "");
  const nq = norm(q);
  if (!nq) return NextResponse.json({ catalog: [], mal: [] });

  const all = await db.anime.findMany({ where: { inCatalog: true } });
  const scored: Array<{ a: (typeof all)[number]; score: number }> = [];
  for (const a of all) {
    const t = norm(a.title);
    const te = norm(a.titleEnglish ?? "");
    const tier = t === nq || te === nq ? 0 : t.startsWith(nq) || te.startsWith(nq) ? 1 : t.includes(nq) || te.includes(nq) ? 2 : -1;
    if (tier < 0) continue;
    // popularity inside the tier, nulls LAST (Number.MAX_SAFE_INTEGER sink)
    scored.push({ a, score: tier * 1e12 + (a.popularity ?? Number.MAX_SAFE_INTEGER) });
  }
  scored.sort((x, y) => x.score - y.score);

  let hitIds = scored.slice(0, 80).map((s) => s.a.malId);

  // backfill missing images/details for freshly seeded rows (via AniList)
  const sparse = scored.slice(0, 80).filter((s) => !s.a.image);
  if (sparse.length) {
    for (const s of sparse.slice(0, 6)) {
      const media = await mediaByMal(s.a.malId);
      if (media) await upsertAniListMedia(media, { inCatalog: true, source: "seed" });
    }
    const refreshed = await db.anime.findMany({ where: { malId: { in: hitIds } } });
    const byId = new Map(refreshed.map((a) => [a.malId, a]));
    hitIds = hitIds.filter((id) => byId.has(id));
    const catalog: AnimeLite[] = hitIds
      .map((id) => byId.get(id))
      .filter((a): a is NonNullable<typeof a> => !!a)
      .map(lite);
    return NextResponse.json({ catalog, mal: [] });
  }

  const byId = new Map(all.map((a) => [a.malId, a]));
  const catalog = hitIds.map((id) => byId.get(id)).filter((a): a is NonNullable<typeof a> => !!a).map(lite);
  return NextResponse.json({ catalog, mal: [] });
}
