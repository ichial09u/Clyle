/**
 * Import the Zoko/Kiwi hit list (scripts/zoko-catalog-probe.json) into the
 * catalog: anime rows (AniList metadata, rank = popularity position) plus
 * episode rows 1..aired. Run AFTER probe-zoko-catalog.mjs.
 *
 * - popularity = the AniList popularity rank from the probe (app sorts asc)
 * - episodes: AniList count (or nextAiring-1 for airing shows); long-runners
 *   without any count fall back to Jikan's episode list (bounded budget)
 * - bulk episodes get a 90-day-old addedAt so the Latest tab is not flooded
 *   by the import — genuinely new episodes (sync) still arrive with now()
 * - existing rows (the 77 seeded) are only refreshed, never demoted
 *
 * Usage: node scripts/import-zoko-catalog.mjs [--max N]
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";

const db = new PrismaClient();
const PROGRESS = new URL("./zoko-import-progress.json", import.meta.url).pathname;
const ANILIST = "https://graphql.anilist.co";
const JIKAN = "https://api.jikan.moe/v4";

const MAX = Number(process.argv.includes("--max") ? process.argv[process.argv.indexOf("--max") + 1] : 0);
const JIKAN_BUDGET = Number(process.env.JIKAN_BUDGET ?? 140);
const BATCH = 50;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// merge every tranche file (popularity / favourites / score) — one entry per
// malId, keeping the best (lowest) popularity rank across tranches
const here = new URL(".", import.meta.url).pathname;
const probeFiles = readdirSync(here).filter((f) => /^zoko-catalog-probe.*\.json$/.test(f) && !f.includes("progress"));
const byMal = new Map();
for (const f of probeFiles) {
  const s = JSON.parse(readFileSync(here + f, "utf8"));
  for (const h of s.hits ?? []) {
    const prev = byMal.get(h.malId);
    if (!prev || h.rank < prev.rank) byMal.set(h.malId, h);
  }
}
const hits = [...byMal.values()].sort((a, b) => a.rank - b.rank);
const existing = new Set((await db.anime.findMany({ select: { malId: true } })).map((a) => a.malId));
const fresh = hits.filter((h) => !existing.has(h.malId));
if (MAX > 0) fresh.length = Math.min(fresh.length, MAX);
console.log(`probe: ${hits.length} hits · ${existing.size} rows already in db · ${fresh.length} to import`);

const done = new Set(existsSync(PROGRESS) ? JSON.parse(readFileSync(PROGRESS, "utf8")).imported : []);

/* ---------------- AniList metadata (batched) ---------------- */
const CORE = `
  id idMal title { romaji english native } coverImage { extraLarge large } bannerImage
  description format status episodes duration averageScore popularity favourites
  genres season seasonYear isAdult studios(isMain: true) { nodes { name } }
  trailer { id site } nextAiringEpisode { episode }
`;

function anilistToRow(m, rank) {
  if (!m || !Number.isFinite(m.idMal)) return null;
  const genres = [...(m.genres ?? [])];
  return {
    malId: m.idMal,
    title: m.title?.english || m.title?.romaji || `Anime ${m.idMal}`,
    titleEnglish: m.title?.english ?? null,
    image: m.coverImage?.extraLarge ?? m.coverImage?.large ?? null,
    banner: m.bannerImage ?? null,
    synopsis: m.description ?? null,
    type: m.format ?? null,
    rating: null,
    ratingShort: null,
    status: m.status === "RELEASING" ? "Currently Airing" : m.status === "FINISHED" ? "Finished Airing" : m.status === "NOT_YET_RELEASED" ? "Not yet aired" : (m.status ?? null),
    airing: m.status === "RELEASING",
    season: m.season ? m.season.toLowerCase() : null,
    year: m.seasonYear ?? null,
    durationMin: m.duration && m.duration > 0 ? (m.format === "MOVIE" ? m.duration : Math.min(m.duration, 60)) : null,
    score: m.averageScore != null ? m.averageScore / 10 : null,
    rank: null,
    popularity: rank, // AniList popularity order position — app sorts ascending
    members: m.favourites ?? null,
    genres: JSON.stringify(genres),
    studios: JSON.stringify((m.studios?.nodes ?? []).map((s) => s.name)),
    trailerYt: m.trailer?.site === "youtube" ? m.trailer.id : null,
    totalEpisodes: 0, // filled by the episode pass below
  };
}

async function anilistBatch(malIds) {
  // Page{ media(idMal_in) } returns EVERY match (the singular Media query
  // returns only the first one — learned the hard way: 4930 bare rows)
  const query = `query Imp($ids:[Int]){Page(perPage:50){media(type:ANIME,idMal_in:$ids){${CORE}}}}`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(ANILIST, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query, variables: { ids: malIds } }),
        signal: AbortSignal.timeout(25_000),
      });
      if (res.status === 429) {
        await sleep(35_000);
        continue;
      }
      const json = await res.json();
      const list = json?.data?.Page?.media;
      return Array.isArray(list) ? list : [];
    } catch {
      await sleep(6_000 * attempt);
    }
  }
  return [];
}

/* ---------------- episodes ---------------- */
const BULK_AGE = 90 * 864e5; // 90 days ago — keeps the import out of Latest
let jikanUsed = 0;

async function jikanEpisodeCount(malId) {
  if (jikanUsed >= JIKAN_BUDGET) return null;
  jikanUsed++;
  try {
    const res = await fetch(`${JIKAN}/anime/${malId}/episodes?page=1`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const rows = json?.data ?? [];
    const maxOnPage = rows.reduce((m, r) => Math.max(m, Number(r.mal_id) || 0), 0);
    return maxOnPage > 0 ? maxOnPage : null;
  } catch {
    return null;
  }
}

async function importEpisodes(malId, count) {
  if (!count || count <= 0) return 0;
  const have = await db.episode.findMany({ where: { animeId: malId, lang: "sub" }, select: { number: true } });
  const haveSet = new Set(have.map((e) => e.number));
  const missing = [];
  for (let n = 1; n <= count; n++) if (!haveSet.has(n)) missing.push(n);
  if (!missing.length) return 0;
  const addedAt = new Date(Date.now() - BULK_AGE);
  await db.episode.createMany({
    data: missing.map((n) => ({ animeId: malId, number: n, lang: "sub", addedAt })),
  });
  return missing.length;
}

/* ---------------- run ---------------- */
const imported = [];
let rowsAdded = 0;
let epsAdded = 0;
let noCount = 0;

for (let i = 0; i < fresh.length; i += BATCH) {
  const slice = fresh.slice(i, i + BATCH);
  const medias = await anilistBatch(slice.map((h) => h.malId));
  const byId = new Map(medias.map((m) => [m.idMal, m]));

  for (const hit of slice) {
    if (done.has(hit.malId)) continue;
    const m = byId.get(hit.malId);
    const rank = hit.rank ?? 999999;
    const row = anilistToRow(m, rank);
    if (!row) {
      // AniList has no mapping — still add a snapshot row so the id is playable
      await db.anime.upsert({
        where: { malId: hit.malId },
        create: { malId: hit.malId, title: `Anime ${hit.malId}`, inCatalog: true, source: "zoko-import", popularity: rank, genres: "[]" },
        update: { inCatalog: true },
      });
      rowsAdded++;
      imported.push(hit.malId);
      continue;
    }

    // episode count: AniList total, else aired (nextAiring-1), else Jikan tail
    let count = m.episodes ?? 0;
    if (!count && m.nextAiringEpisode?.episode) count = m.nextAiringEpisode.episode - 1;
    if (!count) count = (await jikanEpisodeCount(hit.malId)) ?? 0;
    if (!count) noCount++;

    await db.anime.upsert({ where: { malId: hit.malId }, create: { ...row, inCatalog: true, source: "zoko-import", lastSyncedAt: new Date() }, update: { inCatalog: true, popularity: rank, lastSyncedAt: new Date() } });
    rowsAdded++;
    epsAdded += await importEpisodes(hit.malId, count);
    if (count > 0) await db.anime.updateMany({ where: { malId: hit.malId, totalEpisodes: { lt: count } }, data: { totalEpisodes: count } });
    imported.push(hit.malId);
  }

  writeFileSync(PROGRESS, JSON.stringify({ imported }));
  console.log(`batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(fresh.length / BATCH)}: +${slice.length} (rows ${rowsAdded}, eps ${epsAdded}, jikan ${jikanUsed}/${JIKAN_BUDGET})`);
  await sleep(1200);
}

writeFileSync(PROGRESS, JSON.stringify({ imported }));
const totalAnime = await db.anime.count({ where: { inCatalog: true } });
const totalEps = await db.episode.count();
console.log(`DONE: +${rowsAdded} anime rows (+${epsAdded} episodes) · ${noCount} left without a count · catalog now ${totalAnime} anime / ${totalEps} episodes`);
