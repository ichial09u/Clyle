import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { jikan, jikanOne, type JikanAnime } from "@/lib/jikan";
import { upsertAnime, importEpisodes } from "@/lib/sync";
import { lite } from "@/lib/serialize";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/import  body: { malId: number }
 * Imports any anime by its MAL id into the Zoko catalog and immediately
 * materialises all of its current episodes.
 */
export async function POST(req: Request) {
  let body: { malId?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad body" }, { status: 400 });
  }
  const malId = Number(body.malId);
  if (!Number.isFinite(malId) || malId <= 0) return NextResponse.json({ error: "bad malId" }, { status: 400 });

  const full = await jikanOne<JikanAnime>(`/anime/${malId}/full`);
  if (!full) return NextResponse.json({ error: "MAL anime not found" }, { status: 404 });

  await upsertAnime(full, { inCatalog: true, source: "manual" });
  const episodesAdded = await importEpisodes(malId, full.episodes ?? 0);

  const row = await db.anime.findUnique({ where: { malId } });
  return NextResponse.json({ anime: row ? lite(row) : null, episodesAdded });
}
