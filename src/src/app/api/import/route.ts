import { NextResponse, after } from "next/server";
import { db } from "@/lib/db";
import { jikanOne, type JikanAnime } from "@/lib/jikan";
import { anilistToJikan, airedEpisodeCount, mediaByMal } from "@/lib/anilist";
import { upsertAnime, importEpisodes, importEpisodesFromList, isAdultAnime } from "@/lib/sync";
import { isOwnerRequest, rateLimit, clientIp } from "@/lib/guard";
import { prefetchSkipTimes } from "@/lib/skip-times";
import { fanartLogoFor, fanartEnabled } from "@/lib/fanart";
import { lite } from "@/lib/serialize";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/import  body: { malId: number }
 * Imports any anime by its MAL id into the Zoko catalog and immediately
 * materialises all of its current episodes. AniList-first, Jikan fallback.
 * User-facing (the genre suggestions "+" buttons) — protected by an adult
 * guard and a per-client rate limit instead of an owner gate; owner-token
 * callers (scripts) bypass the limit.
 */
export async function POST(req: Request) {
  const owner = isOwnerRequest(req);
  if (!owner && !rateLimit(`import:${clientIp(req)}`, 4, 60_000)) {
    return NextResponse.json({ error: "slow down" }, { status: 429 });
  }

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
  // never let hentai in (same guard as the catalog sync — genre-based; the
  // AniList mapper carries genres but MAL's age-rating string arrives null)
  if (conv && isAdultAnime(conv)) {
    return NextResponse.json({ error: "adult title" }, { status: 451 });
  }
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

  // official title logo for the poster cards (background; only with FANART_API_KEY)
  if (fanartEnabled()) {
    after(async () => {
      const url = await fanartLogoFor(malId);
      if (url) await db.anime.update({ where: { malId }, data: { logoUrl: url } }).catch(() => undefined);
    });
  }

  const row = await db.anime.findUnique({ where: { malId } });
  return NextResponse.json({ anime: row ? lite(row) : null, episodesAdded });
}
