import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
async function main() {
  const bySource = await db.anime.groupBy({
    by: ["source"],
    where: { inCatalog: true },
    _count: { malId: true },
    _sum: { totalEpisodes: true },
  });
  console.log("== catalog by source ==");
  for (const s of bySource) console.log(s.source, "count:", s._count.malId, "eps:", s._sum.totalEpisodes);
  const dubCounts = await db.anime.groupBy({
    by: ["hasDub"],
    where: { inCatalog: true },
    _count: { malId: true },
  });
  console.log("== hasDub distribution ==");
  for (const d of dubCounts) console.log("hasDub =", d.hasDub, "count:", d._count.malId);
  const epLangs = await db.episode.groupBy({ by: ["lang"], _count: { id: true } });
  console.log("== episodes by lang ==");
  for (const e of epLangs) console.log(e.lang, e._count.id);
  const total = await db.anime.count({ where: { inCatalog: true } });
  const eps = await db.episode.count();
  console.log("TOTAL inCatalog:", total, "| episodes:", eps);
  // sample newest imported
  const newest = await db.anime.findMany({
    where: { inCatalog: true, source: { not: "seed" } },
    orderBy: { createdAt: "desc" },
    take: 8,
    select: { malId: true, title: true, source: true, hasDub: true, createdAt: true, totalEpisodes: true },
  });
  console.log("== newest imported ==");
  for (const n of newest) console.log(n.malId, "|", (n.title ?? "").slice(0, 40), "| src:", n.source, "| hasDub:", n.hasDub, "| eps:", n.totalEpisodes);
}
main().finally(() => db.$disconnect());
