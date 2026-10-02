import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
for (const malId of [21, 59193, 62513]) {
  const a = await db.anime.findUnique({
    where: { malId },
    select: { title: true, titleEnglish: true, year: true, nextEpisodeNum: true, nextEpisodeAt: true },
  });
  console.log(malId, JSON.stringify(a));
}
await db.$disconnect();
