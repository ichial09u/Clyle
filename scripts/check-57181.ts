import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
async function main() {
  const a = await db.anime.findUnique({ where: { malId: 57181 }, select: { malId: true, title: true, inCatalog: true, source: true, hasDub: true, createdAt: true } });
  console.log("local 57181:", JSON.stringify(a));
  const b = await db.anime.findUnique({ where: { malId: 59192 }, select: { malId: true, title: true, inCatalog: true, source: true, hasDub: true, createdAt: true } });
  console.log("local 59192:", JSON.stringify(b));
  const total = await db.anime.count();
  console.log("local anime rows TOTAL (incl not inCatalog):", total);
  const byIn = await db.anime.groupBy({ by: ["inCatalog"], _count: { malId: true } });
  console.log("inCatalog dist:", JSON.stringify(byIn));
}
main().finally(() => db.$disconnect());
