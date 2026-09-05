import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const [animes, intro, refs, probes, audio, findings, scoutErr, nodetect, epNoTitle, epTotal] = await Promise.all([
  p.anime.count({ where: { inCatalog: true } }),
  p.introScout.count(),
  p.scoutRef.count(),
  p.dubProbe.count(),
  p.dubAudio.count(),
  p.scoutFinding.count(),
  p.scoutFinding.count({ where: { status: "error" } }),
  p.introScout.count({ where: { nodetect: true } }),
  p.episode.count({ where: { title: null } }),
  p.episode.count(),
]);
console.log(JSON.stringify({ animes, intro, refs, probes, audio, findings, scoutErr, nodetect, epNoTitle, epTotal }, null, 1));
const recentErr = await p.scoutFinding.findMany({ where: { status: "error" }, orderBy: { createdAt: "desc" }, take: 8, select: { bot: true, malId: true, ep: true, detail: true, createdAt: true } });
console.log("recent errors:"); for (const e of recentErr) console.log(` ${e.bot} ${e.malId} ep${e.ep}: ${(e.detail||"").slice(0,90)}`);
const lastFinding = await p.scoutFinding.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } });
const lastProbe = await p.dubProbe.findFirst({ orderBy: { updatedAt: "desc" }, select: { updatedAt: true } });
console.log("last finding:", lastFinding?.createdAt, "| last probe:", lastProbe?.updatedAt);
await p.$disconnect();
