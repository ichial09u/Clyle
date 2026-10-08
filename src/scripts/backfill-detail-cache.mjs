/**
 * Backfill DetailCache — harvest AniList relations + recommendations for
 * every catalog anime into the DetailCache table, so the packaged custom.db
 * ships warm and /api/anime/{id} answers its "Other Seasons" + "You May
 * Also Like" sections from ONE SQLite read (see lib/detail-sections.ts).
 *
 * Usage:  DATABASE_URL=file:<src>/db/custom.db node scripts/backfill-detail-cache.mjs
 * - Resumable: skips malIds already present in DetailCache.
 * - Reuses complete entries from src/db/anilist-cache (same cache-key format
 *   as lib/anilist.ts) before hitting the network.
 * - Does NOT write the anilist disk cache (kept network-only here — a
 *   trimmed payload must never masquerade as a full media record).
 * - Throttled ~1.25s/request; 429/5xx retry with backoff; failures are
 *   collected and retried once at the end.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = join(ROOT, "db", "anilist-cache");
const PROGRESS_FILE = join(ROOT, "..", "scripts", "detail-cache-progress.json");
const REPORT_FILE = join(ROOT, "..", "scripts", "detail-cache-report.json");

const BASE = "https://graphql.anilist.co";
const MIN_INTERVAL_MS = 1250;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_TRIES = 3;

// Trimmed — everything computeSections needs (named MediaByMal so the
// cache-key format matches lib/anilist.ts for reading existing files).
const QUERY = `
query MediaByMal($idMal: Int) {
  Media(type: ANIME, idMal: $idMal) {
    id
    idMal
    relations {
      edges {
        relationType
        node {
          id
          idMal
          title { romaji english }
          coverImage { extraLarge large }
        }
      }
    }
    recommendations(sort: RATING_DESC, perPage: 24) {
      nodes {
        mediaRecommendation {
          id
          idMal
          title { romaji english }
          coverImage { extraLarge large }
        }
      }
    }
  }
}`;

const RELATION_MAP = {
  SEQUEL: "Sequel",
  PREQUEL: "Prequel",
  PARENT: "Parent story",
  SIDE_STORY: "Side story",
  SPIN_OFF: "Spin-off",
  ALTERNATIVE: "Alternative version",
  ADAPTATION: "Adaptation",
  SUMMARY: "Summary",
  CHARACTER: "Character",
  OTHER: "Other",
  SOURCE: "Source",
  CONTAINS: "Contains",
};
const SEASON_RELATIONS = new Set(["Sequel", "Prequel", "Side story", "Summary", "Alternative version", "Parent story"]);

const db = new PrismaClient();
let lastRequestAt = 0;
let done = 0;
let total = 0;
let fetchedCount = 0;
let cacheHits = 0;
const failures = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cacheKey = (malId) => `MediaByMal:${JSON.stringify({ idMal: malId })}`;

function diskPath(key) {
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 24);
  return join(CACHE_DIR, `${hash}.json`);
}

async function diskPeek(malId) {
  try {
    const entry = JSON.parse(await readFile(diskPath(cacheKey(malId)), "utf8"));
    const media = entry?.data?.Media;
    if (media && media.relations && media.recommendations !== undefined) return media; // complete full-query record
    return null;
  } catch {
    return null;
  }
}

async function fetchMedia(malId) {
  const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRequestAt));
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();

  let lastErr = null;
  for (let tries = 0; tries < MAX_TRIES; tries++) {
    try {
      const res = await fetch(BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query: QUERY, variables: { idMal: malId } }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`permanent HTTP ${res.status}`);
      const json = await res.json();
      if (json.errors?.length) {
        const msg = json.errors[0]?.message ?? "GraphQL error";
        if (/Not Found/i.test(msg)) return { notFound: true };
        throw new Error(`permanent ${msg}`);
      }
      return { media: json.data?.Media ?? null };
    } catch (err) {
      lastErr = err;
      if (String(err).includes("permanent")) return { error: String(err) };
      if (tries < MAX_TRIES - 1) {
        await sleep(5_000 * (tries + 1));
        lastRequestAt = Date.now();
      }
    }
  }
  return { error: String(lastErr) };
}

function computeSections(media) {
  const otherSeasons = [];
  for (const edge of media.relations?.edges ?? []) {
    const rel = RELATION_MAP[edge.relationType] ?? "Other";
    if (!SEASON_RELATIONS.has(rel)) continue;
    const node = edge.node;
    if (!node?.idMal) continue;
    otherSeasons.push({
      malId: node.idMal,
      name: node.title?.english ?? node.title?.romaji ?? `#${node.idMal}`,
      relation: rel,
      image: node.coverImage?.extraLarge ?? node.coverImage?.large ?? null,
    });
  }
  const similar = (media.recommendations?.nodes ?? [])
    .map((n) => n.mediaRecommendation)
    .filter((m) => m && m.idMal && m.idMal > 0)
    .slice(0, 24)
    .map((m) => ({
      malId: m.idMal,
      name: m.title?.english ?? m.title?.romaji ?? `#${m.idMal}`,
      image: m.coverImage?.extraLarge ?? m.coverImage?.large ?? null,
    }));
  return { otherSeasons, similar };
}

async function saveProgress(extra = {}) {
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(PROGRESS_FILE, JSON.stringify({ done, total, fetchedCount, cacheHits, failures: failures.length, ...extra }), "utf8");
  } catch {
    /* best-effort */
  }
}

async function processAnime(malId) {
  const cachedMedia = await diskPeek(malId);
  let sections;
  if (cachedMedia) {
    cacheHits++;
    sections = computeSections(cachedMedia);
  } else {
    const out = await fetchMedia(malId);
    if (out.notFound) {
      failures.push({ malId, error: "AniList Not Found — skipped" });
      return false;
    }
    if (out.error || !out.media) {
      failures.push({ malId, error: out.error ?? "no media" });
      return false;
    }
    sections = computeSections(out.media);
    fetchedCount++;
  }
  await db.detailCache.upsert({
    where: { malId },
    update: {
      otherSeasons: JSON.stringify(sections.otherSeasons.slice(0, 24)),
      similar: JSON.stringify(sections.similar.slice(0, 24)),
      fetchedAt: new Date(),
    },
    create: {
      malId,
      otherSeasons: JSON.stringify(sections.otherSeasons.slice(0, 24)),
      similar: JSON.stringify(sections.similar.slice(0, 24)),
    },
  });
  return true;
}

async function main() {
  const existing = new Set((await db.detailCache.findMany({ select: { malId: true } })).map((r) => r.malId));
  const rows = await db.anime.findMany({
    orderBy: [{ inCatalog: "desc" }, { popularity: "desc" }],
    select: { malId: true },
  });
  const queue = rows.map((r) => r.malId).filter((malId) => !existing.has(malId));
  total = queue.length;
  console.log(`[backfill] ${rows.length} anime, ${existing.size} already cached, ${total} to harvest`);

  for (const malId of queue) {
    const ok = await processAnime(malId);
    done++;
    if (done % 25 === 0 || done === total) {
      await saveProgress({ current: malId });
      console.log(`[backfill] ${done}/${total} (fetched ${fetchedCount}, disk-hits ${cacheHits}, failed ${failures.length})`);
    }
    if (!ok) await sleep(300); // failed — brief pause before the next id
  }

  // one retry pass for transient failures
  const retry = failures.splice(0, failures.length);
  if (retry.length) {
    console.log(`[backfill] retrying ${retry.length} failures`);
    for (const f of retry) {
      const ok = await processAnime(f.malId);
      done++; // already counted; harmless
      if (ok) continue;
      failures.push(f); // keep the original failure record
    }
  }

  const report = {
    totalAnime: rows.length,
    alreadyCached: existing.size,
    processed: total,
    fetched: fetchedCount,
    diskHits: cacheHits,
    failures,
    finishedAt: new Date().toISOString(),
  };
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(REPORT_FILE, JSON.stringify(report, null, 2), "utf8");
  } catch {
    /* best-effort */
  }
  console.log(`[backfill] DONE — fetched ${fetchedCount}, disk-hits ${cacheHits}, failures ${failures.length}`);
  console.log(`[backfill] report: ${REPORT_FILE}`);
}

main()
  .catch((e) => {
    console.error("[backfill] fatal:", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
