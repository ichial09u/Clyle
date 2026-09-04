import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const a = await db.anime.findUnique({ where: { malId: 57334 } });
console.log(JSON.stringify({
  malId: a?.malId, title: a?.title,
  dubThruS1: a?.dubThruS1, dubHiS1: a?.dubHiS1,
  dubThruS2: a?.dubThruS2, dubHiS2: a?.dubHiS2,
  hasDub: a?.hasDub, hasDubKiwi: a?.hasDubKiwi, hasDubMega: a?.hasDubMega,
  anikotoSeriesId: a?.anikotoSeriesId, supaplayPath: a?.supaplayPath,
  totalEpisodes: a?.totalEpisodes, dubThruCheckedAt: a?.dubThruCheckedAt,
}, null, 2));
await db.$disconnect();
