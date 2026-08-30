/**
 * Seed the Zoko catalog: fetch details for every SEED_CATALOG malId and
 * materialise episodes. Resumable — only rows that still lack details
 * (lastSyncedAt IS NULL) are fetched, so it is safe to re-run until the
 * whole catalog is populated.
 *
 * Usage:
 *   bun scripts/seed-catalog.ts            # fill missing details (all)
 *   bun scripts/seed-catalog.ts --limit 15 # fill at most 15 per run
 *   bun scripts/seed-catalog.ts --sync     # also run a full sync afterwards
 */
import { db } from "../src/lib/db";
import { SEED_CATALOG } from "../src/lib/catalog-seed";
import { jikanOneFresh, type JikanAnime } from "../src/lib/jikan";
import { upsertAnime, importEpisodes, importEpisodesFromList, syncCatalog } from "../src/lib/sync";

const args = process.argv.slice(2);
const limitArg = args.indexOf("--limit");
const LIMIT = limitArg >= 0 ? parseInt(args[limitArg + 1], 10) || 0 : 0;
const RUN_SYNC = args.includes("--sync");

async function main() {
  console.log(`Seeding catalog from Jikan (MAL)...${LIMIT ? ` (limit ${LIMIT})` : ""}`);

  // ensure placeholder rows exist for every seed entry
  for (const seed of SEED_CATALOG) {
    await db.anime.upsert({
      where: { malId: seed.malId },
      create: { malId: seed.malId, title: seed.title, inCatalog: true, source: "seed" },
      update: { inCatalog: true },
    });
  }

  // fetch details for whatever is still sparse
  const sparse = await db.anime.findMany({
    where: { inCatalog: true, lastSyncedAt: null },
    select: { malId: true, title: true },
    ...(LIMIT ? { take: LIMIT } : {}),
  });
  console.log(`${sparse.length} anime need details.`);

  let ok = 0;
  const failed: number[] = [];
  for (const s of sparse) {
    const full = await jikanOneFresh<JikanAnime>(`/anime/${s.malId}/full`);
    if (!full) {
      console.warn(`  ! ${s.malId} ${s.title}: MAL unavailable, will retry next run`);
      failed.push(s.malId);
      continue;
    }
    await upsertAnime(full, { inCatalog: true, source: "seed" });
    const eps = full.airing && !full.episodes
      ? await importEpisodesFromList(s.malId) // long-runner: MAL hides the count
      : await importEpisodes(s.malId, full.episodes ?? 0);
    ok++;
    console.log(`  + ${full.mal_id} ${full.title} (${full.type ?? "?"}, ${full.episodes ?? 0} eps, airing=${full.airing}) epsImported=${eps}`);
  }
  console.log(`Details filled: ${ok}/${sparse.length}. ${failed.length ? `Still pending: ${failed.join(", ")}` : "All done."}`);

  if (RUN_SYNC) {
    console.log("Running catalog sync (season import + fresh episodes)...");
    const result = await syncCatalog(true);
    console.log("Sync result:", JSON.stringify(result));
  }

  const counts = {
    anime: await db.anime.count({ where: { inCatalog: true } }),
    detailed: await db.anime.count({ where: { inCatalog: true, NOT: { lastSyncedAt: null } } }),
    episodes: await db.episode.count(),
  };
  console.log(`Catalog: ${counts.anime} anime (${counts.detailed} detailed) / ${counts.episodes} episodes.`);
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
