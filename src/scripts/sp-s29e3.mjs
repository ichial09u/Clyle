/**
 * Bake Season 29 Episode 3 + the next-episode timer into the bundled DB
 * (db/custom.db). The freshness scrape would import E3 on the first
 * episodes view anyway, but baking it means the grid, the downloads panel
 * and playback resolve on the very first deploy without waiting for that
 * background pass — and the bundled DB stays the source of truth the
 * data-sync bot folds live data into.
 *
 * Timer: Comedy Central drops S29 episodes biweekly Wednesdays 10pm ET.
 * TVmaze show 112 (the live source the episodes API refreshes from) has
 * E4 scheduled for 2026-10-28 10pm ET = 2026-10-29T02:00:00Z. Setting
 * Anime.nextEpisodeAt/Num on 999929 lights up every surface the animes'
 * countdown lives on (detail-hero pill, Top Airing ordering, the 3-day
 * card badge).
 *
 * Usage: DATABASE_URL=file:<src>/db/custom.db node scripts/sp-s29e3.mjs
 * Idempotent — safe to re-run (upserts).
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const S29 = 999929; // South Park Season 29 (the airing entry)
const E3 = {
  number: 3,
  title: "You Like That On Your Face", // WCO page title, verified 2026-10-17
  slug: "south-park-season-29-episode-3-you-like-that-on-your-face",
};
const E4_AIR_SEC = Math.floor(Date.parse("2026-10-29T02:00:00Z") / 1000); // 1793239200

async function main() {
  const anime = await db.anime.findUnique({ where: { malId: S29 } });
  if (!anime) throw new Error(`Anime row ${S29} missing — the per-season entries were never seeded`);

  const ep = await db.episode.upsert({
    where: { animeId_number_lang: { animeId: S29, number: E3.number, lang: "sub" } },
    update: { title: E3.title, slug: E3.slug },
    create: { animeId: S29, number: E3.number, title: E3.title, slug: E3.slug, lang: "sub" },
  });

  await db.anime.update({
    where: { malId: S29 },
    data: {
      totalEpisodes: Math.max(anime.totalEpisodes, E3.number),
      airing: true,
      nextEpisodeAt: E4_AIR_SEC,
      nextEpisodeNum: 4,
    },
  });

  console.log(
    `[sp-s29e3] E${ep.number} "${ep.title}" upserted; 999929 total=${Math.max(anime.totalEpisodes, E3.number)}, nextEpisodeAt=${E4_AIR_SEC} (EP 4, ${new Date(E4_AIR_SEC * 1000).toISOString()})`,
  );
}

main()
  .catch((e) => {
    console.error("[sp-s29e3] fatal:", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
