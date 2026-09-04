import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
// Dandadan S1 MAL id = 48583, S2 = 60424 (Dan Da Dan season 2)
const direct = await db.anime.findMany({
  where: { malId: { in: [48583, 60424, 62516] } },
  select: { malId: true, title: true, titleEnglish: true, type: true, hasDub: true, hasDubKiwi: true, hasDubMega: true, supaplayPath: true, supaplaySeason: true, anikotoSeriesId: true, dubThruS1: true, dubHiS1: true, dubThruS2: true, dubHiS2: true, inCatalog: true, totalEpisodes: true }
});
console.log('=== Direct malId lookup (48583=S1, 60424=S2, 62516=S3) ===');
for (const a of direct) console.log(JSON.stringify(a));

// broader title search
const like = await db.anime.findMany({ where: { OR: [{ title: { contains: "Dan Da" } }, { titleEnglish: { contains: "Dan Da" } }, { title: { contains: "Dandadan" } }, { titleEnglish: { contains: "Dandadan" } }] }, select: { malId: true, title: true, inCatalog: true, hasDub: true } });
console.log('=== Fuzzy title matches ===');
for (const a of like) console.log(JSON.stringify(a));
await db.$disconnect();
