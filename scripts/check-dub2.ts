import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
async function main() {
  const b = await db.anime.findUnique({ where: { malId: 57181 }, select: { title: true, hasDub: true, totalEpisodes: true } });
  const d = await db.anime.findUnique({ where: { malId: 59192 }, select: { title: true, hasDub: true, totalEpisodes: true } });
  console.log("57181:", JSON.stringify(b));
  console.log("59192:", JSON.stringify(d));
  const nullDub = await db.anime.count({ where: { inCatalog: true, hasDub: null } });
  const total = await db.anime.count({ where: { inCatalog: true } });
  console.log("hasDub=null:", nullDub, "/", total);
}
main().finally(() => db.$disconnect());
