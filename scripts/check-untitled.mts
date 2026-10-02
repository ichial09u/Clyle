import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

// recent imports grouped by anime: how many rows untitled?
const recent = await db.episode.findMany({
  orderBy: { addedAt: "desc" },
  take: 300,
  select: { animeId: true, number: true, title: true, addedAt: true },
});
const byAnime = new Map();
for (const e of recent) {
  const a = byAnime.get(e.animeId) ?? { total: 0, untitled: 0, maxEp: 0, latestAdded: e.addedAt };
  a.total++;
  if (!e.title) a.untitled++;
  a.maxEp = Math.max(a.maxEp, e.number);
  byAnime.set(e.animeId, a);
}
console.log("recent-import animes:", byAnime.size);
for (const [malId, a] of [...byAnime.entries()].slice(0, 12)) {
  const anime = await db.anime.findUnique({ where: { malId }, select: { title: true, airing: true } });
  console.log(`malId=${malId} ${anime?.title?.slice(0, 32).padEnd(34)} airing=${anime?.airing ? 1 : 0} rows=${a.total} untitled=${a.untitled} maxEp=${a.maxEp}`);
}

// total untitled in whole episode table
const untitled = await db.episode.count({ where: { title: null } });
const total = await db.episode.count();
console.log("\nwhole table: untitled", untitled, "/", total);
await db.$disconnect();
