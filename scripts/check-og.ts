import { PrismaClient } from "@prisma/client";
const db = new PrismaClient({ datasources: { db: { url: "file:" + process.cwd() + "/db/custom.db" } } });
async function main() {
  const og = await db.anime.findUnique({ where: { malId: 64340 }, select: { malId: true, title: true, inCatalog: true, source: true, type: true } });
  console.log("Overgeared (64340):", og ?? "NOT IN DB");
  const sword = await db.anime.findUnique({ where: { malId: 53913 }, select: { malId: true, title: true, inCatalog: true } });
  console.log("Reincarnated as a Sword S2 (53913, ONA):", sword ?? "NOT IN DB");
  const edgerunners = await db.anime.findUnique({ where: { malId: 61990 }, select: { malId: true, title: true, inCatalog: true } });
  console.log("Edgerunners 2 (61990, ONA):", edgerunners ?? "NOT IN DB");
  const steel = await db.anime.findUnique({ where: { malId: 61469 }, select: { malId: true, title: true, inCatalog: true } });
  console.log("Steel Ball Run (61469, ONA):", steel ?? "NOT IN DB");
  const boss = await db.anime.findUnique({ where: { malId: 63140 }, select: { malId: true, title: true, inCatalog: true } });
  console.log("Wild Last Boss S2 (63140, ONA):", boss ?? "NOT IN DB");
  const counts = await db.anime.groupBy({ by: ["inCatalog"], _count: true });
  console.log("catalog counts:", counts);
}
main().finally(() => db.$disconnect());
