import { PrismaClient } from "@prisma/client";
const db = new PrismaClient({ datasources: { db: { url: "file:" + process.cwd() + "/db/custom.db" } } });

async function main() {
  // exact where-clause the OG genre route will use
  const og = await db.anime.findMany({
    where: { inCatalog: true, year: { not: null, lte: 2009 } },
    orderBy: [{ popularity: { sort: "asc", nulls: "last" } }, { members: "desc" }],
    take: 8,
    select: { title: true, titleEnglish: true, year: true, popularity: true },
  });
  const ogCount = await db.anime.count({ where: { inCatalog: true, year: { not: null, lte: 2009 } } });
  console.log("OG count:", ogCount);
  for (const a of og) console.log(`  - ${a.titleEnglish ?? a.title} (${a.year}) pop=${a.popularity}`);
}
main().finally(() => db.$disconnect());
