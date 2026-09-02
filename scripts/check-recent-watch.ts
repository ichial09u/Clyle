import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
async function main() {
  const wp = await db.watchProgress.findMany({
    orderBy: { updatedAt: "desc" }, take: 12,
    select: { malId: true, episode: true, lang: true, server: true, updatedAt: true, title: true },
  });
  console.log("== recent WatchProgress ==");
  for (const w of wp) console.log(w.malId, "ep", w.episode, w.lang, w.server, "|", (w.title ?? "").slice(0,38), "|", w.updatedAt.toISOString());
  const ws = await db.watchStat.findMany({ orderBy: { updatedAt: "desc" }, take: 10, select: { malId: true, day: true, seconds: true, title: true } });
  console.log("== recent WatchStat ==");
  for (const w of ws) console.log(w.day, w.malId, w.seconds + "s", (w.title ?? "").slice(0, 38));
}
main().finally(() => db.$disconnect());
