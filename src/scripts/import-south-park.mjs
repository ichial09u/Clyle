/**
 * RETIRED — do not run. This script seeds the OLD single-entry aggregator
 * (malId 999999, flat episode numbers 1..338+). Task 27 split the franchise
 * into per-season entries (999900 = Movies & Specials, 999901..999929 =
 * Seasons 1..29) keyed by their REAL per-season numbers; re-running this
 * would resurrect the retired 999999 catalog row and pollute the genre
 * grid. Episode data now flows from lib/wco-sp-episodes.ts (baked manifest)
 * + the freshness scrape in the episodes API; see scripts/sp-s29e3.mjs for
 * the per-season baking pattern.
 *
 * Usage: DATABASE_URL=file:<src>/db/custom.db node scripts/import-south-park.mjs
 * Idempotent — safe to re-run (upserts).
 */
import { PrismaClient } from "@prisma/client";

if (!process.env.SP_LEGACY_IMPORT) {
  console.error(
    "[south-park] RETIRED: this legacy single-entry import would resurrect the retired 999999 aggregator row.\n" +
      "Per-season data comes from lib/wco-sp-episodes.ts + the freshness scrape; per-season baking lives in scripts/sp-s29e3.mjs.\n" +
      "(Set SP_LEGACY_IMPORT=1 if you truly need the legacy behaviour.)",
  );
  process.exit(1);
}


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
