import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { jikan, jikanOne, type JikanAnime } from "@/lib/jikan";
import { anilistMalIdNotFound, anilistToJikan, mediaByMal, peekMediaByMal, relationName } from "@/lib/anilist";
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
 *
 * ── Latency contract (the "detail button hangs 11-25s" fix) ──────────────
 * This route NEVER awaits a cold AniList/MAL fetch:
 *   - catalog anime: relations/similar come from the CACHE-ONLY peek
 *     (peekMediaByMal — instant, even if stale). Cold cache → answer
 *     immediately with `pending: true` while a background mediaByMal() warms
 *     it; DetailsView re-polls and the follow-up request is fully warm.
 *   - unknown anime (imported via MAL-id search): the import is BUDGET-RACED
 *     at 4s. If it loses the race it keeps running in the background
 *     (in-flight deduped) and the route answers `pending: true`.
 *   - the Jikan fallbacks for relations/recommendations are budget-raced at
 *     2.5s each — a dead MAL never blocks the response, it just trims the
 *     sections for that request.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ malId: string }> }) {
  const { malId: malIdStr } = await params;
  const malId = parseInt(malIdStr, 10);
  if (!Number.isFinite(malId)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  let row = await db.anime.findUnique({ where: { malId } });

  // ---- unknown anime: budget-raced import (in-flight deduped) ----
  if (!row) {
    const outcome = await Promise.race([
      importUnknown(malId).then((ok) => (ok ? "done" : "failed")),
      sleep(4_000).then(() => "timeout"),
    ]);
    if (outcome === "timeout") {
      // import still running (real upstream slowness) — the client re-polls
      return NextResponse.json({ pending: true }, { headers: { "Cache-Control": "no-store" } });
    }
    if (outcome === "failed") {
      // proven nonexistent on BOTH sources (negative-memoised for 10 min)
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    row = await db.anime.findUnique({ where: { malId } });
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const anime = lite(row);

  // ---- cache-only peek: relations + recommendations sources ----
  const media = await peekMediaByMal(malId);
  if (!media) {
    // cold cache — never block: warm it in the background, answer now.
    // (mediaByMal is the disk-cached reader; when it lands, the client's
    // re-poll gets the full sections in one warm round-trip.)
    void mediaByMal(malId).catch(() => null);
    return NextResponse.json(
      { anime, otherSeasons: [], similar: [], pending: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // ---- Other Seasons (Sequel / Prequel / Side story / Summary / …) ----
  const otherSeasons: Array<{ malId: number; name: string; relation: string; image: string | null; inCatalog: boolean }> = [];

  const pushRelated = async (rel: string, malId2: number, name: string, image: string | null) => {
    const relRow = await db.anime.findUnique({ where: { malId: malId2 }, select: { image: true, inCatalog: true } });
    otherSeasons.push({ malId: malId2, name, relation: rel, image: relRow?.image ?? image, inCatalog: relRow?.inCatalog ?? false });
  };

  if (media.relations?.edges?.length) {
    for (const edge of media.relations.edges) {
      const rel = relationName(edge.relationType);
      if (!SEASON_RELATIONS.includes(rel)) continue;
      const node = edge.node;
      const relatedMal = node?.idMal ?? null;
      if (!node || !relatedMal) continue;
      await pushRelated(rel, relatedMal, node.title?.english ?? node.title?.romaji ?? `#${relatedMal}`, node.coverImage?.extraLarge ?? node.coverImage?.large ?? null);
    }
  } else if (!isJikanFallbackDead("rel", malId)) {
    // Jikan fallback for the relations graph — budget-raced 2.5s
    const full = await Promise.race([
      jikanOne<JikanAnime>(`/anime/${malId}/full`),
      sleep(2_500).then(() => null),
    ]);
    const relations = (row.inCatalog ? full?.relations : []) ?? [];
    if (!relations.length) markJikanFallbackDead("rel", malId);
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

  if (media.recommendations?.nodes?.length) {
    const recs = media.recommendations.nodes
      .map((n) => n.mediaRecommendation)
      .filter((m): m is NonNullable<typeof m> => !!m)
      .map(anilistToJikan)
      .filter((a): a is JikanAnime => !!a)
      .slice(0, 24);
    similar = await buildSimilar(recs);
  } else if (!isJikanFallbackDead("rec", malId)) {
    // Jikan fallback — budget-raced 2.5s
    const recs = await Promise.race([
      jikan<{ data: Array<{ entry: JikanAnime }> }>(`/anime/${malId}/recommendations`),
      sleep(2_500).then(() => null),
    ]);
    const recEntries = (recs?.data ?? []).map((r) => r.entry).slice(0, 24);
    if (!recEntries.length) markJikanFallbackDead("rec", malId);
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

  return NextResponse.json(
    { anime, otherSeasons: otherSeasons.slice(0, 12), similar: similar.slice(0, 12), pending: false },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/* ---------------- helpers ---------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Jikan-fallback failure memo: an anime whose cached AniList media carries no
// relations/recommendations would re-run the 2.5s budget-raced Jikan fallback
// on EVERY view (the "pathological 2198" pattern). After a fallback comes up
// empty, skip it for 5 minutes — those views answer pure-cache instantly.
const JIKAN_FALLBACK_TTL_MS = 5 * 60_000;
const jikanFallbackDead = new Map<string, number>(); // "rel:malId" | "rec:malId" -> ts
const isJikanFallbackDead = (which: string, malId: number): boolean => {
  const t = jikanFallbackDead.get(`${which}:${malId}`);
  return t != null && Date.now() - t < JIKAN_FALLBACK_TTL_MS;
};
const markJikanFallbackDead = (which: string, malId: number) => {
  if (jikanFallbackDead.size > 3000) jikanFallbackDead.clear();
  jikanFallbackDead.set(`${which}:${malId}`, Date.now());
};

// dedup concurrent imports of the same unknown anime (the client re-polls
// while pending — every poll must join the SAME in-flight import, not spawn
// another)
const inflightImports = new Map<number, Promise<boolean>>();

// negative memo: an id that BOTH sources prove dead gets remembered briefly
// so garbage-id hammering fails fast (404) instead of re-burning the 4s
// import budget on every hit. Short TTL on purpose: a total upstream outage
// looks identical to "not found" here, and a real anime must never stay
// 404ed for long.
const IMPORT_NEG_TTL_MS = 60_000;
const importFailures = new Map<number, number>(); // malId -> ts of proven failure

async function importUnknown(malId: number): Promise<boolean> {
  const failedAt = importFailures.get(malId);
  if (failedAt && Date.now() - failedAt < IMPORT_NEG_TTL_MS) return false;

  const existing = inflightImports.get(malId);
  if (existing) return existing;

  const p = (async () => {
    const media = await mediaByMal(malId);
    const conv = media ? anilistToJikan(media) : null;
    if (conv) {
      await upsertAnime(conv, { inCatalog: false, source: "lookup" });
      return true;
    }
    // AniList came up empty — is that AUTHORITATIVE ("not an anime id", its
    // mapping covers every MAL anime) or just an upstream hiccup? Only a
    // proven Not Found may negative-memo; a hiccup must not 404 a real anime.
    if (await anilistMalIdNotFound(malId)) {
      if (importFailures.size > 2000) importFailures.clear();
      importFailures.set(malId, Date.now());
      return false;
    }
    // Jikan last chance — budget-raced so a shedding MAL can't hang the
    // import (its worst case is ~84s of 504 retries+backoffs)
    const full = await Promise.race([
      jikanOne<JikanAnime>(`/anime/${malId}/full`),
      sleep(2_500).then(() => null),
    ]);
    if (full) {
      await upsertAnime(full, { inCatalog: false, source: "lookup" });
      return true;
    }
    return false; // unproven — this hit 404s, no memo, retried next time
  })()
    .catch(() => false)
    .finally(() => inflightImports.delete(malId));

  inflightImports.set(malId, p);
  return p;
}
