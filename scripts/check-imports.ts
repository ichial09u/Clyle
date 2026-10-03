import { PrismaClient } from "@prisma/client";
const db = new PrismaClient({ datasources: { db: { url: "file:" + process.cwd() + "/db/custom.db" } } });
const IDS = [64340, 53913, 61990, 63140, 64459, 56733, 63509, 64131, 63489];
async function main() {
  for (const id of IDS) {
    const a = await db.anime.findUnique({ where: { malId: id }, select: { malId: true, title: true, type: true, airing: true, totalEpisodes: true, source: true } });
    const eps = await db.episode.count({ where: { animeId: id, lang: "sub" } });
    console.log(`${id} ${a ? `${a.title} [${a.type}] airing=${a.airing} total=${a.totalEpisodes} eps=${eps} src=${a.source}` : "NOT IN DB"}`);
  }
}
main().finally(() => db.$disconnect());
