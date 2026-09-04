import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const dans = await p.anime.findMany({ where: { OR: [{ title: { contains: "Dan" } }, { titleEnglish: { contains: "Dan" } }] }, select: { malId: true, title: true, hasDub: true, hasDubKiwi: true, hasDubMega: true, dubThruS1: true, dubThruS2: true, totalEpisodes: true } });
console.log("dandadan-ish animes:", JSON.stringify(dans, null, 1));
const mal = dans[0]?.malId;
if (mal) {
  const eps = await p.episode.count({ where: { animeId: mal } });
  const titled = await p.episode.count({ where: { animeId: mal, title: { not: null } } });
  console.log(`episodes for ${mal}: ${eps}, titled: ${titled}`);
  const da = await p.dubAudio.findMany({ where: { malId: mal }, select: { ep: true, server: true, verdict: true, method: true } });
  console.log("DubAudio rows:", JSON.stringify(da));
  const dp = await p.dubProbe.count({ where: { malId: mal, ok: true } });
  console.log("DubProbe ok rows:", dp);
}
// fake dubs still on record
const fakes = await p.dubAudio.findMany({ where: { verdict: "fake" }, select: { malId: true, ep: true, server: true } });
console.log("fake dub rows:", JSON.stringify(fakes));
await p.$disconnect();
