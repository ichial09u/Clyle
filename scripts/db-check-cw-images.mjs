// Diagnostic: check WatchProgress.image vs catalog Anime.image for recent CW rows
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const rows = await db.watchProgress.findMany({
  orderBy: { updatedAt: "desc" },
  take: 14,
});

for (const r of rows) {
  const cat = await db.anime.findUnique({ where: { malId: r.malId }, select: { image: true, title: true } });
  console.log(
    `mal=${r.malId} ep=${r.episode} updated=${r.updatedAt.toISOString()}\n  stored: ${r.image ?? "NULL"}\n  catalog: ${cat?.image ?? "__NO_CATALOG__"} (${cat?.title ?? "-"})`
  );
}

const agg = await db.watchProgress.aggregate({ _count: true });
const nullImg = await db.watchProgress.count({ where: { image: null } });
console.log("\nTotal progress rows:", agg._count, "| null image rows:", nullImg);

const noImg = await db.anime.findMany({ where: { image: null }, select: { malId: true, title: true }, take: 10 });
console.log("Catalog rows missing image:", JSON.stringify(noImg));

await db.$disconnect();
