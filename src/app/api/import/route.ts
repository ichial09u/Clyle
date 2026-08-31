import { NextResponse, after } from "next/server";
import { db } from "@/lib/db";
import { jikanOne, type JikanAnime } from "@/lib/jikan";
import { anilistToJikan, airedEpisodeCount, mediaByMal } from "@/lib/anilist";
import { upsertAnime, importEpisodes, importEpisodesFromList } from "@/lib/sync";
import { prefetchSkipTimes } from "@/lib/skip-times";
import { lite } from "@/lib/serialize";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/import  body: { malId: number }
 * Imports any anime by its MAL id into the Zoko catalog and immediately
 * materialises all of its current episodes. AniList-first, Jikan fallback.
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

  // AniList first — one request carries everything we need
  const media = await mediaByMal(malId);
  const conv = media ? anilistToJikan(media) : null;
  let episodesAdded = 0;
  const newEpisodes: Array<{ malId: number; ep: number; lenMin?: number | null }> = [];

  if (conv) {
    await upsertAnime(conv, { inCatalog: true, source: "manual" });
    const added = await importEpisodes(malId, airedEpisodeCount(media) ?? 0);
    episodesAdded = added.length;
    const meta = await db.anime.findUnique({ where: { malId }, select: { durationMin: true } });
    newEpisodes.push(...added.map((ep) => ({ malId, ep, lenMin: meta?.durationMin })));
  } else {
    // AniList has no MAL mapping (or is unreachable) — fall back to Jikan
    const full = await jikanOne<JikanAnime>(`/anime/${malId}/full`);
    if (!full) return NextResponse.json({ error: "anime not found" }, { status: 404 });
    await upsertAnime(full, { inCatalog: true, source: "manual" });
    const added = full.airing && !full.episodes
      ? await importEpisodesFromList(malId)
      : await importEpisodes(malId, full.episodes ?? 0);
    episodesAdded = added.length;
    const meta = await db.anime.findUnique({ where: { malId }, select: { durationMin: true } });
    newEpisodes.push(...added.map((ep) => ({ malId, ep, lenMin: meta?.durationMin })));
  }

  // imported episodes bring their skip intro/ending along (background, rate-limited)
  if (newEpisodes.length) after(() => prefetchSkipTimes(newEpisodes, 40));

  const row = await db.anime.findUnique({ where: { malId } });
  return NextResponse.json({ anime: row ? lite(row) : null, episodesAdded });
}
