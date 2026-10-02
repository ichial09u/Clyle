// One-off seed: backfill titles for the most popular airing shows that still
// have untitled episodes (the rows viewers actually see in Latest/Continue).
import { backfillEpisodeTitles } from "../src/lib/sync.ts";
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

const shows = await db.anime.findMany({
  where: {
    inCatalog: true,
    airing: true,
    episodes: { some: { lang: "sub", title: null } },
  },
  orderBy: { popularity: "asc" },
  take: 30,
  select: { malId: true, title: true },
});

let total = 0;
for (const s of shows) {
  const n = await backfillEpisodeTitles(s.malId).catch(() => -1);
  total += Math.max(n, 0);
  console.log(`${String(s.malId).padEnd(7)} ${String(n).padStart(3)}  ${s.title.slice(0, 44)}`);
}
console.log("TOTAL filled:", total);
await db.$disconnect();
