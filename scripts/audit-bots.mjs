import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
// 1. mirror ingestion check
const sf = await p.scoutFinding.count();
const recentOk = await p.scoutFinding.count({ where: { status: "ok", createdAt: { gte: new Date(Date.now() - 15 * 60_000) } } });
const recentErr = await p.scoutFinding.count({ where: { status: "error", createdAt: { gte: new Date(Date.now() - 15 * 60_000) } } });
console.log(`ScoutFinding total=${sf}, last 15min: ok=${recentOk} err=${recentErr}`);
// 2. IntroScout growth since restart
const newIntro = await p.introScout.count({ where: { updatedAt: { gte: new Date(Date.now() - 20 * 60_000) } } });
console.log(`IntroScout rows touched last 20min: ${newIntro}`);
// 3. contradiction audit: hasDub flags vs dub boundary evidence
const contradiction = await p.$queryRawUnsafe(`
  SELECT malId, title, hasDub, hasDubKiwi, dubThruS1, dubThruS2 FROM Anime
  WHERE inCatalog = 1 AND (hasDub = 0 OR hasDub IS NULL) AND (dubThruS1 >= 1 OR dubThruS2 >= 1)
  LIMIT 12`);
console.log(`\nhasDub=false but dubThru>=1 (S2-only or audio-verified fakes — expected for megaplay backfills):`);
for (const r of contradiction) console.log(`  ${r.malId} ${r.title?.slice(0,40)} hasDub=${r.hasDub} kiwi=${r.hasDubKiwi} thruS1=${r.dubThruS1} thruS2=${r.dubThruS2}`);
const n = await p.$queryRawUnsafe(`SELECT COUNT(*) c FROM Anime WHERE inCatalog=1 AND (hasDub=0 OR hasDub IS NULL) AND (dubThruS1>=1 OR dubThruS2>=1)`);
console.log("  total:", n[0].c);
// 4. reverse contradiction: hasDub=true but boundaries never established
const rev = await p.$queryRawUnsafe(`SELECT COUNT(*) c FROM Anime WHERE inCatalog=1 AND hasDub=1 AND dubThruS1 IS NULL AND dubThruS2 IS NULL`);
console.log(`\nhasDub=true but no boundaries (needs fleet probes): ${rev[0].c}`);
// 5. DubAudio fake rows and whether playback has fallback
const fakes = await p.$queryRawUnsafe(`SELECT malId, ep, server FROM DubAudio WHERE verdict='fake'`);
console.log(`DubAudio fake rows: ${fakes.length} ->`, fakes.map(f=>`${f.malId}e${f.ep}@${f.server}`).join(", "));
await p.$disconnect();
process.exit(0);
