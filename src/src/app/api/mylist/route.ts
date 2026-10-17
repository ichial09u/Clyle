import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { jikan, jikanOne, type JikanAnime } from "@/lib/jikan";
import { isAdultAnime } from "@/lib/sync";
import { lite } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/** POST /api/mylist  body: { malIds: number[] } — hydrate My List entries from the client's localStorage. */
export async function POST(req: Request) {
  let body: { malIds?: number[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad body" }, { status: 400 });
  }
  // isInteger, not isFinite — a fractional id throws PrismaClientValidationError (Int column)
  const ids = (body.malIds ?? []).filter((n) => Number.isInteger(n)).slice(0, 100);
  if (!ids.length) return NextResponse.json({ items: [] });

  const rows = await db.anime.findMany({ where: { malId: { in: ids } } });
  const byId = new Map(rows.map((r) => [r.malId, lite(r)]));

  // anything not in the DB yet gets a quick MAL lookup — CAPPED: a fresh
  // device re-listing 100 unknown ids used to fire 100 sequential upstream
  // calls inside this request (Jikan rate-limits, the visitor waits for all)
  const missing = ids.filter((id) => !byId.has(id));
  const LOOKUP_CAP = 10;
  let lookups = 0;
  for (const id of missing) {
    if (lookups >= LOOKUP_CAP) break; // the rest render from cache next visit / after a sync
    lookups += 1;
    const full = await jikanOne<JikanAnime>(`/anime/${id}/full`);
    if (!full) continue;
    // hentai guard — adult titles never hydrate into the DB at all
    if (isAdultAnime(full)) continue;
    const row = await db.anime.upsert({
      where: { malId: id },
      create: {
        malId: id,
        title: full.title,
        titleEnglish: full.title_english ?? null,
        image: full.images?.webp?.large_image_url ?? full.images?.jpg?.image_url ?? null,
        banner: full.trailer?.images?.maximum_image_url ?? null,
        synopsis: full.synopsis ?? null,
        type: full.type ?? null,
        rating: full.rating ?? null,
        ratingShort: full.rating?.split(" - ")[0] ?? null,
        status: full.status ?? null,
        airing: !!full.airing,
        season: full.season ?? null,
        year: full.year ?? null,
        durationMin: full.duration ? parseInt(full.duration.match(/(\d+)\s*min/)?.[1] ?? "0", 10) || null : null,
        score: full.score ?? null,
        rank: full.rank ?? null,
        popularity: full.popularity ?? null,
        members: full.members ?? null,
        genres: JSON.stringify([...(full.genres ?? []), ...(full.themes ?? [])].map((g) => g.name)),
        studios: JSON.stringify((full.studios ?? []).map((s) => s.name)),
        trailerYt: full.trailer?.youtube_id ?? null,
        totalEpisodes: full.episodes ?? 0,
        inCatalog: false,
        source: "mylist",
        lastSyncedAt: new Date(),
      },
      update: { lastSyncedAt: new Date() },
    });
    byId.set(id, lite(row));
  }

  const items = ids.map((id) => byId.get(id)).filter((x): x is NonNullable<typeof x> => !!x);
  return NextResponse.json({ items });
}
