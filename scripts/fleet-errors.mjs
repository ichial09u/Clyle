import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
// error detail buckets
const errs = await p.scoutFinding.findMany({ where: { status: "error" }, select: { detail: true, malId: true, ep: true, bot: true } });
const buckets = {};
for (const e of errs) {
  const d = (e.detail || "unknown").slice(0, 60).replace(/malId=\d+/g, "malId=X").replace(/ep=\d+/g, "ep=X").replace(/\d+\.\d+s/g, "Ns");
  const key = d.replace(/q=0.\d+/, "q=X");
  buckets[key] = (buckets[key] || 0) + 1;
}
console.log("ERROR BUCKETS:"); Object.entries(buckets).sort((a,b)=>b[1]-a[1]).slice(0,15).forEach(([k,v])=>console.log(` ${v}  ${k}`));
// which animes generate most errors
const byAnime = {};
for (const e of errs) byAnime[e.malId] = (byAnime[e.malId] || 0) + 1;
const top = Object.entries(byAnime).sort((a,b)=>b[1]-a[1]).slice(0,12);
const details = await p.anime.findMany({ where: { malId: { in: top.map(t=>+t[0]) } }, select: { malId: true, title: true, hasDub: true, dubThruS1: true, dubThruS2: true, totalEpisodes: true } });
const dmap = Object.fromEntries(details.map(d=>[d.malId,d]));
console.log("\nTOP ERROR ANIMES:");
for (const [id, n] of top) console.log(` ${n}x  ${dmap[id]?.title ?? id} [${id}] ${JSON.stringify(dmap[id]||{})}`);
// no-audio animes list
const noAudio = errs.filter(e => (e.detail||"").includes("no audio")).map(e=>e.malId);
console.log("\nno-audio anime ids:", [...new Set(noAudio)].join(", "));
// intro rows quality spread
const bad = await p.introScout.count({ where: { quality: { lt: 0.72 } } });
const degenerate = await p.introScout.count({ where: { start: 0, end: 0 } });
const zeroLen = await p.introScout.count({ where: { OR: [ { end: 0 }, { start: { gte: p.introScout.fields.end } } ] } });
console.log(`\nintro rows: quality<0.72: ${bad}, degenerate 0-0: ${degenerate}`);
// dubprobe false: animes with probes saying no dub
const noDub = await p.dubProbe.findMany({ where: { ok: false }, select: { malId: true, ep: true, chain: true } });
const animeIds = [...new Set(noDub.map(d=>d.malId))];
console.log(`dubprobe no-dub rows: ${noDub.length} across ${animeIds.length} animes: ${animeIds.slice(0,20).join(",")}`);
// episodes with titles for dandadan
const dd = await p.episode.count({ where: { animeId: 91822, title: { not: null } } });
const ddTotal = await p.episode.count({ where: { animeId: 91822 } });
console.log(`\nDandadan titles: ${dd}/${ddTotal}`);
await p.$disconnect();
