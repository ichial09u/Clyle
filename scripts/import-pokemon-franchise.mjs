/**
 * Re-import the Pokémon franchise into the local catalog (db/custom.db).
 *
 * History note: the original 86-title import lived only on the prod server —
 * the offline-viewing deploy later shipped the packaged local DB over it and
 * the whole Pokémon genre (tile + titles) vanished. From now on the
 * franchise lives in the bundled DB, so every deploy carries it.
 *
 * What it does:
 *   - searches AniList for the franchise ("Pokémon" + "Pocket Monsters"),
 *     keeps entries whose title matches, maps them onto the Anime schema
 *     and upserts them with the "Pokémon" pseudo-genre tag (prepended, so
 *     /api/genre/Pokémon and the pinned tile find them);
 *   - materialises Episode rows (sub) for every known episode count so the
 *     episode grids answer instantly;
 *   - leaves dub verdicts / logoUrl / streaming metadata untouched on
 *     re-runs (update never clobbers them).
 *
 * Usage: node scripts/import-pokemon-franchise.mjs
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const POKEMON_GENRE = "Pokémon";

const QUERY = `
query ($search: String, $page: Int) {
  Page(page: $page, perPage: 50) {
    pageInfo { hasNextPage currentPage }
    media(search: $search, type: ANIME, sort: POPULARITY_DESC, isAdult: false) {
      id
      idMal
      title { romaji english native }
      description(asHtml: false)
      coverImage { extraLarge large }
      bannerImage
      format
      status
      episodes
      duration
      season
      seasonYear
      startDate { year month day }
      averageScore
      genres
      studios(isMain: true) { nodes { name } }
      popularity
      rankings { rank type allTime context }
      nextAiringEpisode { episode airingAt }
    }
  }
}
`;

async function anilist(search, page) {
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { search, page } }),
  });
  if (!res.ok) throw new Error(`anilist ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data.Page;
}

const POKE_RE = /pok[eé]|pocket\s*monster/i;

const TYPE_MAP = {
  TV: "TV",
  TV_SHORT: "TV",
  MOVIE: "Movie",
  SPECIAL: "Special",
  OVA: "OVA",
  ONA: "ONA",
  MUSIC: "Music",
};

const STATUS_MAP = {
  RELEASING: "Currently Airing",
  FINISHED: "Finished Airing",
  NOT_YET_RELEASED: "Not yet aired",
  CANCELLED: "Cancelled",
  HIATUS: "On Hiatus",
};

function mapMedia(m) {
  const romaji = m.title?.romaji?.trim() || m.title?.english?.trim() || m.title?.native?.trim() || "Pokémon";
  const english = m.title?.english?.trim() || null;
  // catalog convention is English-leaning display titles ("Pokémon Journeys",
  // not "Pocket Monsters (2019)") — romaji stays as the fallback
  const display = english ?? romaji;
  const genres = [...new Set([POKEMON_GENRE, ...(m.genres ?? [])].filter(Boolean))];
  const popRank = m.rankings?.find((r) => r.type === "POPULAR" && r.allTime)?.rank ?? null;
  const rateRank = m.rankings?.find((r) => m0(r))?.rank ?? null;
  function m0(r) {
    return r.type === "RATED" && r.allTime;
  }
  const nextEp = m.nextAiringEpisode?.episode ?? null;
  const total =
    m.episodes ??
    (nextEp && nextEp > 1 ? nextEp - 1 : m.format === "MOVIE" ? 1 : 0);
  return {
    malId: m.idMal,
    title: display,
    titleEnglish: english,
    image: m.coverImage?.extraLarge ?? m.coverImage?.large ?? null,
    banner: m.bannerImage ?? null,
    synopsis: m.description ? m.description.replace(/<[^>]*>/g, "").replace(/\s+\n/g, "\n").trim() : null,
    type: TYPE_MAP[m.format] ?? m.format ?? null,
    status: STATUS_MAP[m.status] ?? m.status ?? null,
    airing: m.status === "RELEASING",
    season: m.season ? m.season[0] + m.season.slice(1).toLowerCase() : null,
    year: m.seasonYear ?? m.startDate?.year ?? null,
    durationMin: m.duration ?? null,
    score: m.averageScore != null ? m.averageScore / 10 : null,
    rank: rateRank,
    popularity: popRank,
    members: m.popularity ?? null,
    genres: JSON.stringify(genres),
    studios: JSON.stringify((m.studios?.nodes ?? []).map((s) => s.name)),
    totalEpisodes: total ?? 0,
    source: "manual",
  };
}

async function ensureEpisodeRows(malId, total) {
  const n = Math.min(Math.max(total ?? 0, 0), 3000);
  if (n <= 0) return 0;
  const existingRows = await db.episode.findMany({
    where: { animeId: malId, lang: "sub" },
    select: { number: true },
  });
  const have = new Set(existingRows.map((r) => r.number));
  const rows = [];
  for (let num = 1; num <= n; num++) if (!have.has(num)) rows.push({ animeId: malId, number: num, lang: "sub" });
  if (!rows.length) return 0;
  try {
    const res = await db.episode.createMany({ data: rows }); // skipDuplicates unsupported on SQLite
    return res.count;
  } catch {
    // one bad row must not sink the batch — create the rest individually
    let added = 0;
    for (const row of rows) {
      try {
        await db.episode.create({ data: row });
        added++;
      } catch {
        /* duplicate from a concurrent import — fine */
      }
    }
    return added;
  }
}

async function main() {
  // gather the franchise across the two searchable title families
  const byId = new Map();
  for (const search of ["Pokémon", "Pocket Monsters"]) {
    let page = 1;
    for (let guard = 0; guard < 4; guard++) {
      const pg = await anilist(search, page).catch((e) => {
        console.error(`[pokemon] search "${search}" p${page} failed:`, e.message);
        return null;
      });
      if (!pg) break;
      for (const m of pg.media ?? []) {
        const t = `${m.title?.romaji ?? ""} ${m.title?.english ?? ""} ${m.title?.native ?? ""}`;
        if (m.idMal && POKE_RE.test(t)) byId.set(m.id, m);
      }
      if (!pg.pageInfo?.hasNextPage) break;
      page++;
    }
  }

  console.log(`[pokemon] AniList returned ${byId.size} franchise entries with MAL ids`);

  let created = 0;
  let updated = 0;
  let epsAdded = 0;
  for (const m of byId.values()) {
    const data = mapMedia(m);
    if (!data.malId) continue;
    const existing = await db.anime.findUnique({ where: { malId: data.malId }, select: { malId: true } });
    const { malId, ...fields } = data;
    try {
      await db.anime.upsert({
        where: { malId },
        update: fields, // never touches logoUrl / dub verdicts / anikoto id
        create: { malId, ...fields, logoUrl: null },
      });
      if (existing) updated++;
      else created++;
      epsAdded += await ensureEpisodeRows(malId, data.totalEpisodes);
    } catch (e) {
      console.error(`[pokemon] upsert failed for malId ${malId} "${data.title}":`, e.message);
    }
  }

  console.log(
    `[pokemon] done — created ${created}, updated ${updated}, episode rows added ${epsAdded}`,
  );
  const total = await db.anime.count({ where: { genres: { contains: `%"${POKEMON_GENRE}"%` } } });
  console.log(`[pokemon] catalog now carries ${total} Pokémon-tagged titles`);
}

main()
  .catch((e) => {
    console.error("[pokemon] fatal:", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
