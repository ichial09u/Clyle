import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
async function main() {
  const dist = await db.anime.groupBy({ by: ["hasDub"], where: { inCatalog: true }, _count: { malId: true } });
  console.log("== hasDub distribution (inCatalog) ==");
  for (const d of dist) console.log(`  hasDub=${d.hasDub}: ${d._count.malId}`);

  const called = [21, 5114, 16498, 57181, 52991, 40748, 117193, 52034];
  const rows = await db.anime.findMany({ where: { malId: { in: called } }, select: { malId: true, title: true, hasDub: true } });
  console.log("== user-called-out titles ==");
  for (const r of rows) console.log(`  ${r.malId} ${(r.title || "").slice(0, 30)} hasDub=${r.hasDub}`);

  const trueCount = await db.anime.count({ where: { inCatalog: true, hasDub: true } });
  const total = await db.anime.count({ where: { inCatalog: true } });
  console.log(`\nTOTAL inCatalog=${total}, hasDub=true=${trueCount}`);
}
main().finally(() => db.$disconnect());
