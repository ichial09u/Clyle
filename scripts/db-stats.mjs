/**
 * DB stats snapshot — title coverage, dub verdicts, scout data.
 * Read-only; run with: node scripts/db-stats.mjs
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const one = async (s) => (await db.$queryRawUnsafe(s))[0];

const main = async () => {
  console.log("anime in catalog:", (await one("SELECT COUNT(*) c FROM Anime WHERE inCatalog=1")).c);
  console.log("sub episodes total:", (await one("SELECT COUNT(*) c FROM Episode WHERE lang='sub'")).c);
  console.log("sub WITH title:", (await one("SELECT COUNT(*) c FROM Episode WHERE lang='sub' AND title IS NOT NULL AND title!=''")).c);
  console.log("sub MISSING title:", (await one("SELECT COUNT(*) c FROM Episode WHERE lang='sub' AND (title IS NULL OR title='')")).c);
  console.log("animes with missing titles:", (await one("SELECT COUNT(DISTINCT animeId) c FROM Episode WHERE lang='sub' AND (title IS NULL OR title='')")).c);
  console.log("\n--- worst offenders (anime, untitled count) ---");
  console.table(
    await db.$queryRawUnsafe(
      "SELECT a.malId, a.title, a.airing, COUNT(*) n FROM Episode e JOIN Anime a ON a.malId=e.animeId WHERE e.lang='sub' AND (e.title IS NULL OR e.title='') GROUP BY e.animeId ORDER BY n DESC LIMIT 20",
    ),
  );
  console.log("--- dub verdicts (hasDub, hasDubKiwi, hasDubMega, count) ---");
  console.table(
    await db.$queryRawUnsafe(
      "SELECT hasDub, hasDubKiwi, hasDubMega, COUNT(*) c FROM Anime WHERE inCatalog=1 GROUP BY hasDub, hasDubKiwi, hasDubMega",
    ),
  );
  console.log("introScout rows:", (await one("SELECT COUNT(*) c FROM IntroScout")).c);
  console.log("scoutRefs:", (await one("SELECT COUNT(*) c FROM ScoutRef")).c);
  console.log("scoutFindings:", (await one("SELECT COUNT(*) c FROM ScoutFinding")).c);
  console.log("supaplay paths mapped:", (await one("SELECT COUNT(*) c FROM Anime WHERE supaplayPath IS NOT NULL AND supaplayPath!=''")).c);
  console.log("\n--- One Piece dub state ---");
  console.table(await db.$queryRawUnsafe("SELECT malId, title, totalEpisodes, hasDub, hasDubKiwi, hasDubMega, airing FROM Anime WHERE malId=21"));
};

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
