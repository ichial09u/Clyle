/**
 * One-off: refresh every catalog anime from AniList (details + banners +
 * aired-episode counts), switching images from MAL's slow CDN to AniList's.
 * Idempotent — safe to re-run.
 *
 *   bun scripts/refresh-from-anilist.ts
 */
import { db } from "../src/lib/db";
import { anilistToJikan, airedEpisodeCount, mediaByMal } from "../src/lib/anilist";
import { upsertAnime, importEpisodes } from "../src/lib/sync";

async function main() {
  const rows = await db.anime.findMany({
    where: { inCatalog: true },
    select: { malId: true, title: true, image: true },
    orderBy: { popularity: "asc" },
  });
  console.log(`Refreshing ${rows.length} catalog anime from AniList...`);

  let ok = 0;
  let eps = 0;
  const failed: number[] = [];
  for (const r of rows) {
    try {
      const media = await mediaByMal(r.malId);
      const conv = media ? anilistToJikan(media) : null;
      if (!conv) {
        failed.push(r.malId);
        continue;
      }
      await upsertAnime(conv, { inCatalog: true, source: "seed" });
      eps += (await importEpisodes(r.malId, airedEpisodeCount(media) ?? 0)).length;
      ok++;
      console.log(`  + ${r.malId} ${conv.title}`);
    } catch (err) {
      failed.push(r.malId);
      console.error(`  ! ${r.malId} ${r.title}:`, err instanceof Error ? err.message : err);
    }
  }

  const counts = {
    anime: await db.anime.count({ where: { inCatalog: true } }),
    anilistImages: await db.anime.count({ where: { inCatalog: true, image: { contains: "anilistcdn" } } }),
    episodes: await db.episode.count(),
  };
  console.log(
    `Refreshed ${ok}/${rows.length} (+${eps} episodes). ` +
      `Catalog now: ${counts.anime} anime, ${counts.anilistImages} on AniList CDN, ${counts.episodes} episodes.` +
      (failed.length ? ` Failed: ${failed.join(", ")}` : ""),
  );
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
