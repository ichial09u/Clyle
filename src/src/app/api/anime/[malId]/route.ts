import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { jikan, jikanOne, type JikanAnime } from "@/lib/jikan";
import { anilistMalIdNotFound, anilistToJikan, mediaByMal, peekMediaByMal, relationName } from "@/lib/anilist";
import {
  computeSections,
  serveSections,
  storeSections,
  warmAndStore,
  type RawSections,
} from "@/lib/detail-sections";
import { upsertAnime } from "@/lib/sync";
import { lite } from "@/lib/serialize";

export const dynamic = "force-dynamic";

const SEASON_RELATIONS = ["Sequel", "Prequel", "Side story", "Summary", "Alternative version", "Parent story"];

/**
 * GET /api/anime/{malId} — full details + Other Seasons + You May Also Like.
 *
 * ── Latency contract (the "details sections take forever" fix) ───────────
 * 1. FAST PATH — sections live in the DetailCache table, which ships inside
 *    the packaged custom.db on every deploy. A hit answers with ONE SQLite
 *    read (plus a live-row merge for fresh posters/flags): instant on every
 *    instance, including the first hit after a cold start. No pending, no
 *    polling.
 * 2. PEEK PATH — no cache row yet, but the instance has the AniList media
 *    cached: compute + write-through the cache, serve complete.
 * 3. COLD PATH — answer immediately with `pending: true` while a background
 *    harvest lands the cache row; the client's re-poll hits path 1.
 *
 * The Jikan fallbacks for relations/recommendations are budget-raced at
 * 2.5s each — a dead MAL never blocks the response, it just trims the
 * sections for that request (and the result is cached so it never repeats).
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

  // ---- FAST PATH: pre-baked sections (ships with the DB) ----
  const served = await serveSections(malId);
  if (served) {
    return NextResponse.json(
      { anime, ...served, pending: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // ---- PEEK PATH: instance has the AniList media cached ----
  const media = await peekMediaByMal(malId);
  if (media) {
    const sections: RawSections = computeSections(media);

    // Jikan backfills ONLY when AniList genuinely lacks a section —
    // budget-raced so a shedding MAL trims sections instead of hanging them.
    if (!sections.otherSeasons.length && !isJikanFallbackDead("rel", malId)) {
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
          sections.otherSeasons.push({ malId: e.mal_id, name: e.name, relation: rel.relation, image: null });
        }
      }
    }
    if (!sections.similar.length && !isJikanFallbackDead("rec", malId)) {
      const recs = await Promise.race([
        jikan<{ data: Array<{ entry: JikanAnime }> }>(`/anime/${malId}/recommendations`),
        sleep(2_500).then(() => null),
      ]);
      const recEntries = (recs?.data ?? []).map((r) => r.entry).slice(0, 24);
      if (!recEntries.length) markJikanFallbackDead("rec", malId);
      sections.similar = recEntries.map((e) => ({
        malId: e.mal_id,
        name: e.title_english ?? e.title,
        image: e.images?.webp?.large_image_url ?? e.images?.jpg?.large_image_url ?? e.images?.jpg?.image_url ?? null,
      }));
    }

    await storeSections(malId, sections); // write-through — this request's work benefits every later one
    const cached = await serveSections(malId);
    if (cached) {
      return NextResponse.json(
        { anime, ...cached, pending: false },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  // ---- COLD PATH: never block — harvest in the background, answer now.
  // (The client re-polls; the follow-up request serves from DetailCache.)
  void warmAndStore(malId);
  return NextResponse.json(
    { anime, otherSeasons: [], similar: [], pending: true },
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
