/**
 * Import South Park (MAL 2304) — the one-entry franchise (Pokémon-tile
 * pattern): a single Anime row carrying ALL seasons + the movie + the
 * specials (338 playable items), TMDB poster art, the owner-supplied
 * wooden-sign logo + town-sign banner, and an empty DetailCache row so the
 * details page answers pending:false instantly (South Park has no AniList
 * mapping — without the row the details route would poll forever).
 *
 * Playback flows through lib/wco.ts (Anime.source = "wco").
 *
 * Usage: DATABASE_URL=file:<src>/db/custom.db node scripts/import-south-park.mjs
 * Idempotent — safe to re-run (upserts).
 */
import { PrismaClient } from "@prisma/client";

const TMDB_KEY = "da679b1021912724c1ed572201e2864c";
const MAL_ID = 999999; // synthetic id — outside MAL range; the real 2304 is SD Gundam Mk-IV
const POSTER = "https://image.tmdb.org/t/p/w500/k7n2EVge7G77eMr3brztRGG1fFU.jpg";
const BANNER = "/art/south-park-banner.jpg"; // owner-uploaded town-sign scene
const LOGO = "/art/south-park-logo.png"; // owner-uploaded wooden sign (transparent)

const db = new PrismaClient();

async function main() {
  // TMDB synopsis (best-effort — the import never hinges on it)
  let synopsis = null;
  try {
    const res = await fetch(`https://api.themoviedb.org/3/tv/2190?api_key=${TMDB_KEY}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) synopsis = (await res.json()).overview ?? null;
  } catch {
    /* optional */
  }

  const { WCO_SP_EPISODES } = await import("./lib-bundle/wco-sp-episodes.mjs");

  const anime = await db.anime.upsert({
    where: { malId: MAL_ID },
    update: {
      title: "South Park",
      titleEnglish: "South Park",
      image: POSTER,
      banner: BANNER,
      logoUrl: LOGO,
      synopsis: synopsis ?? undefined,
      genres: JSON.stringify(["South Park", "Comedy", "Satire"]),
      studios: JSON.stringify(["South Park Studios", "Comedy Central"]),
      type: "TV",
      status: "Currently Airing",
      airing: true,
      year: 1997,
      durationMin: 22,
      totalEpisodes: WCO_SP_EPISODES.length,
      inCatalog: true,
      source: "wco",
      hasSub: true, // WCO's English track answers both selections
      hasDub: true,
      lastSyncedAt: new Date(),
    },
    create: {
      malId: MAL_ID,
      title: "South Park",
      titleEnglish: "South Park",
      image: POSTER,
      banner: BANNER,
      logoUrl: LOGO,
      synopsis: synopsis ?? null,
      genres: JSON.stringify(["South Park", "Comedy", "Satire"]),
      studios: JSON.stringify(["South Park Studios", "Comedy Central"]),
      type: "TV",
      status: "Currently Airing",
      airing: true,
      year: 1997,
      durationMin: 22,
      totalEpisodes: WCO_SP_EPISODES.length,
      inCatalog: true,
      source: "wco",
      hasSub: true,
      hasDub: true,
    },
  });

  let eps = 0;
  for (const e of WCO_SP_EPISODES) {
    await db.episode.upsert({
      where: { animeId_number_lang: { animeId: MAL_ID, number: e.number, lang: "sub" } },
      update: { title: e.title },
      create: { animeId: MAL_ID, number: e.number, title: e.title, lang: "sub" },
    });
    eps++;
  }

  // empty DetailCache row -> the details page answers pending:false at once
  await db.detailCache.upsert({
    where: { malId: MAL_ID },
    update: { fetchedAt: new Date() },
    create: { malId: MAL_ID, otherSeasons: "[]", similar: "[]" },
  });

  console.log(`[south-park] anime row ok (source wco), ${eps} episodes, DetailCache seeded`);
}

main()
  .catch((e) => {
    console.error("[south-park] fatal:", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
