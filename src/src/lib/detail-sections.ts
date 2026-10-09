/**
 * "Other Seasons" + "You May Also Like" — pre-baked detail sections.
 *
 * The details page used to depend on AniList being warm: on Vercel the /tmp
 * AniList cache is per-instance and ephemeral, so most requests answered
 * `pending: true` and the client polled every 2.5s while a background fetch
 * crawled through the rate-limit queue (429 storms stretched that past a
 * minute — the "takes forever" report). Fix: harvest relations +
 * recommendations ONCE into the DetailCache table, which ships inside the
 * packaged custom.db on every deploy. The request path becomes a single
 * SQLite read — instant on every instance, even the first hit after a cold
 * start. Live rows are re-merged at serve time so poster updates (TMDB art)
 * and catalog flags stay current without touching the cache.
 *
 * Freshness: AniList relations/recommendations drift over weeks, not
 * minutes. Serves are never blocked; a cache row older than
 * SECTION_TTL_MS quietly re-harvests in the background (write-through).
 */

import { db } from "@/lib/db";
import {
  mediaByMal,
  anilistToJikan,
  relationName,
  type AniListMedia,
} from "@/lib/anilist";
import type { JikanAnime } from "@/lib/jikan";
import type { RelatedCard } from "@/lib/types";

const SEASON_RELATIONS = ["Sequel", "Prequel", "Side story", "Summary", "Alternative version", "Parent story"];

export const SECTION_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days — re-harvest after, never on the request path

/** Raw stored entry (AniList-derived; no live-row merge yet). */
export interface RawRelated {
  malId: number;
  name: string;
  relation?: string; // Other Seasons only
  image: string | null;
}

export interface RawSections {
  otherSeasons: RawRelated[];
  similar: RawRelated[];
}

/* --------------------------- compute (AniList media -> raw sections) --------------------------- */

/**
 * Extract both sections from one AniList media record — the same rules the
 * route has always applied (relation filter, 24-rec cap, AniList art).
 */
export function computeSections(media: AniListMedia): RawSections {
  const otherSeasons: RawRelated[] = [];

  for (const edge of media.relations?.edges ?? []) {
    const rel = relationName(edge.relationType);
    if (!SEASON_RELATIONS.includes(rel)) continue;
    const node = edge.node;
    const relatedMal = node?.idMal ?? null;
    if (!node || !relatedMal) continue;
    otherSeasons.push({
      malId: relatedMal,
      name: node.title?.english ?? node.title?.romaji ?? `#${relatedMal}`,
      relation: rel,
      image: node.coverImage?.extraLarge ?? node.coverImage?.large ?? null,
    });
  }

  const similar: RawRelated[] = (media.recommendations?.nodes ?? [])
    .map((n) => n.mediaRecommendation)
    .filter((m): m is NonNullable<typeof m> => !!m)
    .map(anilistToJikan)
    .filter((a): a is JikanAnime => !!a)
    .slice(0, 24)
    .map((a) => ({
      malId: a.mal_id,
      name: a.title_english ?? a.title,
      image: a.images?.webp?.large_image_url ?? a.images?.jpg?.large_image_url ?? a.images?.jpg?.image_url ?? null,
    }));

  return { otherSeasons, similar };
}

/* --------------------------- store --------------------------- */

const inflightStores = new Set<number>();

/** Write-through the computed sections (dedupes concurrent harvests). */
export async function storeSections(malId: number, sections: RawSections): Promise<void> {
  if (inflightStores.has(malId)) return;
  inflightStores.add(malId);
  try {
    const row = {
      otherSeasons: JSON.stringify(sections.otherSeasons.slice(0, 24)),
      similar: JSON.stringify(sections.similar.slice(0, 24)),
    };
    await db.detailCache.upsert({
      where: { malId },
      update: { ...row, fetchedAt: new Date() },
      create: { malId, ...row },
    });
  } catch {
    /* best-effort — an unwritten cache row only means the next view re-harvests */
  } finally {
    inflightStores.delete(malId);
  }
}

/** Background harvest: fetch AniList media, compute, store. Never throws. */
export async function warmAndStore(malId: number): Promise<boolean> {
  try {
    const media = await mediaByMal(malId);
    if (!media) return false;
    await storeSections(malId, computeSections(media));
    return true;
  } catch {
    return false;
  }
}

/* --------------------------- serve --------------------------- */

/**
 * Merge raw cached entries with the live Anime table (poster updates,
 * in-catalog flags), catalog-first for You May Also Like — the exact shape
 * the route always returned. One SQLite query for both lists.
 */
async function mergeLive(raw: RawRelated[], withRelation: boolean): Promise<RelatedCard[]> {
  const ids = raw.map((r) => r.malId).filter((n) => Number.isFinite(n));
  if (!ids.length) return [];
  const rows = await db.anime.findMany({
    where: { malId: { in: ids } },
    select: { malId: true, image: true, inCatalog: true },
  });
  const byId = new Map(rows.map((r) => [r.malId, r]));
  const merged: RelatedCard[] = raw.map((r) => {
    const row = byId.get(r.malId);
    return {
      malId: r.malId,
      name: r.name,
      ...(withRelation ? { relation: r.relation ?? "Related" } : {}),
      image: row?.image ?? r.image,
      inCatalog: row?.inCatalog ?? false,
    };
  });
  if (!withRelation) merged.sort((a, b) => Number(b.inCatalog) - Number(a.inCatalog)); // You May Also Like: catalog entries first
  return merged;
}

/**
 * Instant serve from the baked cache. Returns null when this anime has no
 * cache row (the route then falls back to peek/background-warm). Stale rows
 * still serve — a quiet background re-harvest refreshes them.
 */
export async function serveSections(
  malId: number,
): Promise<{ otherSeasons: RelatedCard[]; similar: RelatedCard[] } | null> {
  const cached = await db.detailCache.findUnique({ where: { malId } }).catch(() => null);
  if (!cached) return null;

  let raw: RawSections;
  try {
    raw = { otherSeasons: JSON.parse(cached.otherSeasons) as RawRelated[], similar: JSON.parse(cached.similar) as RawRelated[] };
  } catch {
    return null; // corrupt row — behave as a miss
  }

  // stale? refresh quietly (deduped per instance by inflightStores)
  if (Date.now() - cached.fetchedAt.getTime() > SECTION_TTL_MS) void warmAndStore(malId);

  const [otherSeasons, similar] = await Promise.all([
    mergeLive(raw.otherSeasons, true),
    mergeLive(raw.similar, false),
  ]);
  // 30 for Other Seasons: South Park is spread out per season (Task 27) and
  // every sibling entry is baked — a 12-cap would hide most of them. Shows
  // with AniList-derived sections never have more than ~12 seasons anyway.
  return { otherSeasons: otherSeasons.slice(0, 30), similar: similar.slice(0, 12) };
}
