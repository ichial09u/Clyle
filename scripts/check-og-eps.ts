import { PrismaClient } from "@prisma/client";
const db = new PrismaClient({ datasources: { db: { url: "file:" + process.cwd() + "/db/custom.db" } } });
async function main() {
  const eps = await db.episode.findMany({ where: { animeId: 64340, lang: "sub" }, select: { number: true, title: true, aired: true } });
  console.log("Overgeared episodes:", JSON.stringify(eps));
  const a = await db.anime.findUnique({ where: { malId: 64340 }, select: { title: true, titleEnglish: true, nextEpisodeAt: true, nextEpisodeNum: true } });
  console.log("anime:", JSON.stringify(a));
}
main().finally(() => db.$disconnect());
