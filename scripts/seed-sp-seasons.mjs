/**
 * Task 27 — South Park spread-out (owner changed their mind about the single
 * 999999 aggregator): one catalog entry per season + a Movies & Specials
 * entry, each with its CORRECT per-season TMDB poster.
 *
 *   malId 999900          -> South Park: Movies & Specials (3 WCO items)
 *   malId 999901..999929  -> South Park Season 1..29 (WCO slugs)
 *
 * Also bakes DetailCache rows ("Other Seasons" = the sibling entries) and
 * deletes the old 999999 aggregator (row + episodes + progress).
 *
 * Run:  DATABASE_URL=file:/home/z/my-project/src/db/custom.db \
 *       node /home/z/my-project/scripts/seed-sp-seasons.mjs
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire("/home/z/my-project/src/index.js"); // resolve from src/node_modules
const { PrismaClient } = require("@prisma/client");

const db = new PrismaClient();

// ---- 1. parse the baked WCO manifest (src/lib/wco-sp-episodes.ts) --------
const ts = readFileSync("/home/z/my-project/src/src/lib/wco-sp-episodes.ts", "utf8");
const itemRe =
  /\{\s*number:\s*(\d+),\s*season:\s*(null|\d+),\s*episode:\s*(null|\d+),\s*title:\s*"((?:[^"\\]|\\.)*)",\s*slug:\s*"([^"]+)"\s*\}/g;
const manifest = [];
for (const m of ts.matchAll(itemRe)) {
  manifest.push({
    number: parseInt(m[1], 10),
    season: m[2] === "null" ? null : parseInt(m[2], 10),
    episode: m[3] === "null" ? null : parseInt(m[3], 10),
    title: m[4].replace(/\\'/g, "'").replace(/\\\\/g, "\\"),
    slug: m[5],
  });
}
if (manifest.length !== 338) throw new Error(`manifest parse got ${manifest.length} items, expected 338`);
console.log(`manifest: ${manifest.length} items parsed`);

// ---- 2. TMDB per-season posters (saved by a prior fetch; fetch on miss) ---
const tmdb = JSON.parse(readFileSync("/home/z/my-project/scripts/sp-tmdb-tv.json", "utf8"));
const seasonsTmdb = new Map(
  (tmdb.seasons ?? []).map((s) => [
    s.season_number,
    { poster: s.poster_path ?? null, year: s.air_date ? parseInt(s.air_date.slice(0, 4), 10) : null, name: s.name },
  ]),
);
const w500 = (p) => `https://image.tmdb.org/t/p/w500${p}`;
const seriesPoster = w500(tmdb.poster_path ?? "/k7n2EVge7G77eMr3brztRGG1fFU.jpg");
const posterFor = (season) => {
  const t = seasonsTmdb.get(season);
  return t?.poster ? w500(t.poster) : seriesPoster; // fall back to the series art, never a broken image
};

// ---- 3. the base row (copy shared fields from the 999999 aggregator) -----
const base = await db.anime.findUnique({ where: { malId: 999999 } });
if (!base) throw new Error("999999 row missing — already migrated?");
const shared = {
  synopsis: base.synopsis,
  rating: base.rating,
  ratingShort: base.ratingShort,
  durationMin: base.durationMin,
  genres: base.genres,
  studios: base.studios,
  trailerYt: base.trailerYt,
  banner: base.banner,
  logoUrl: base.logoUrl,
};
const SYNCED = new Date(); // matches "protected, don't sync" — home's sparse import skips synced rows

// ---- 4. build + upsert the 30 entries ------------------------------------
const entries = []; // { malId, season, title }
for (let s = 29; s >= 0; s--) {
  const malId = 999900 + s;
  const isMovies = s === 0;
  const title = isMovies ? "South Park: Movies & Specials" : `South Park Season ${s}`;
  const t = seasonsTmdb.get(s);
  const items = isMovies
    ? manifest.filter((e) => e.season == null) // flat order 336..338 -> 1..3
    : manifest.filter((e) => e.season === s).sort((a, b) => a.episode - b.episode);
  if (!items.length) throw new Error(`season ${s} has no manifest items`);
  const maxNum = isMovies ? items.length : Math.max(...items.map((e) => e.episode));

  // the Anime row must exist first — Episode has an FK on it
  const data = {
    title,
    titleEnglish: title,
    image: posterFor(s),
    type: "TV",
    status: s === 29 ? "Currently Airing" : "Finished Airing",
    airing: s === 29,
    year: isMovies ? 1999 : t?.year ?? 1997,
    totalEpisodes: maxNum,
    hasDub: true, // WCO serves the one natively-English track — dub-only (Task 26)
    hasSub: false,
    popularity: 10005 - s * 10, // sane descending order for search rails
    members: base.members,
    inCatalog: true,
    source: "wco",
    lastSyncedAt: SYNCED,
    ...shared,
  };
  await db.anime.upsert({ where: { malId }, create: { malId, ...data }, update: data });

  await db.episode.deleteMany({ where: { animeId: malId, lang: "sub" } });
  // dead-source slugs (see WCO_SP_DEAD_SLUGS in wco-sp-episodes.ts) — pages
  // pulled / files dead on WCO's side; never materialize them as tiles
  const DEAD_SLUGS = new Set([
    "south-park-season-23-episode-10-christmas-snow",
    "south-park-season-24-episode-3-post-covid",
    "south-park-post-covid",
  ]);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (DEAD_SLUGS.has(it.slug)) continue;
    const number = isMovies ? i + 1 : it.episode; // keep REAL per-season numbers (S28 starts at 2 — WCO has no S28E1)
    await db.episode.create({
      data: { animeId: malId, number, title: it.title, slug: it.slug, lang: "sub" },
    });
  }

  entries.push({ malId, season: s, title });
  console.log(
    `${malId}  ${title.padEnd(34)} eps:${String(maxNum).padStart(3)}  year:${data.year}  ${data.image.split("/").pop()}`,
  );
}

// ---- 5. bake DetailCache ("Other Seasons" = the sibling entries) ----------
// Chronological order (S1..S29, Movies & Specials last) — the serve cap is
// raised to 30 so every sibling is visible. Movies<->Seasons = "Side story".
entries.sort((a, b) => (a.season === 0 ? Infinity : a.season) - (b.season === 0 ? Infinity : b.season));
for (const self of entries) {
  const otherSeasons = entries
    .filter((e) => e.malId !== self.malId)
    .map((e) => ({
      malId: e.malId,
      name: e.title,
      relation:
        e.season === 0 || self.season === 0
          ? "Side story"
          : e.season < self.season
            ? "Prequel"
            : "Sequel",
      image: null, // mergeLive fills from the Anime rows at serve time
    }));
  const row = { otherSeasons: JSON.stringify(otherSeasons), similar: "[]" };
  await db.detailCache.upsert({
    where: { malId: self.malId },
    update: { ...row, fetchedAt: new Date() },
    create: { malId: self.malId, ...row },
  });
}
console.log(`DetailCache baked for ${entries.length} entries`);

// ---- 6. retire the 999999 aggregator --------------------------------------
const oldProgress = await db.watchProgress.deleteMany({ where: { malId: 999999 } });
let oldStats = null;
try {
  oldStats = await db.watchStat.deleteMany({ where: { malId: 999999 } });
} catch {
  /* model may not key on malId */
}
let oldNotify = null;
try {
  oldNotify = await db.animeNotify.deleteMany({ where: { malId: 999999 } });
} catch {
  /* optional */
}
const oldEpisodes = await db.episode.deleteMany({ where: { animeId: 999999 } });
await db.detailCache.delete({ where: { malId: 999999 } }).catch(() => undefined);
await db.anime.delete({ where: { malId: 999999 } });
console.log(
  `999999 retired (episodes:${oldEpisodes.count}, progress:${oldProgress.count}, stats:${oldStats?.count ?? 0}, notify:${oldNotify?.count ?? 0})`,
);

// ---- 7. verification -------------------------------------------------------
const check = await db.anime.findMany({
  where: { malId: { gte: 999900, lte: 999929 } },
  orderBy: { malId: "asc" },
  include: { _count: { select: { episodes: true } } },
});
let bad = 0;
for (const a of check) {
  const tmdbSeason = a.malId - 999900;
  const expect = seasonsTmdb.get(tmdbSeason)?.poster;
  const got = a.image ?? "";
  const ok = expect ? got.endsWith(expect) : got === seriesPoster;
  if (!ok) bad += 1;
  console.log(
    `${ok ? "OK  " : "MISMATCH"} ${a.malId} ${a.title.padEnd(34)} dbEps:${String(a._count.episodes).padStart(3)} total:${String(a.totalEpisodes).padStart(3)} poster:${got.split("/").pop()}`,
  );
}
console.log(bad === 0 ? "ALL POSTERS MATCH TMDB" : `${bad} POSTER MISMATCHES`);
await db.$disconnect();
