#!/usr/bin/env node
/**
 * Restore S23E10 "Christmas Snow" to the grid — it died on WCO (page pulled)
 * and Task 28 dropped the row, but the LM2 fallback (lib/lm2.ts) plays it
 * with real bytes + English CC. The Episode row's slug still points at the
 * WCO page: the stream route tries WCO first (negative-cached when 404),
 * then LM2 (season 23, episode 10 -> id 71957) — playback self-heals.
 *
 * Usage: node scripts/sp-restore-s23e10.mjs
 */
process.env.DATABASE_URL = "file:/home/z/my-project/src/db/custom.db";
const { PrismaClient } = await import("/home/z/my-project/src/node_modules/@prisma/client/index.js").then((m) => ({ PrismaClient: m.PrismaClient }));
const db = new PrismaClient();

const MAL = 999923; // South Park Season 23
const row = await db.episode.upsert({
  where: { animeId_number_lang: { animeId: MAL, number: 10, lang: "sub" } },
  update: { title: "Christmas Snow", slug: "south-park-season-23-episode-10-christmas-snow" },
  create: {
    animeId: MAL,
    number: 10,
    title: "Christmas Snow",
    slug: "south-park-season-23-episode-10-christmas-snow",
    lang: "sub",
  },
});
await db.anime.update({ where: { malId: MAL }, data: { totalEpisodes: 10 } });
console.log("restored:", row.number, row.title, row.slug);
await db.$disconnect();
