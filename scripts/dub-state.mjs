/**
 * One-shot: snapshot the catalog's dub coverage state.
 * How many anime are missing dub, how many are supaplay-mapped, etc.
 */
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const total = await db.anime.count({ where: { inCatalog: true } });
const mapped = await db.anime.count({ where: { inCatalog: true, supaplayPath: { not: null } } });
const hasDubTrue = await db.anime.count({ where: { inCatalog: true, hasDub: true } });
const hasDubFalse = await db.anime.count({ where: { inCatalog: true, hasDub: false } });
const hasDubNull = await db.anime.count({ where: { inCatalog: true, hasDub: null } });
const megaTrue = await db.anime.count({ where: { inCatalog: true, hasDubMega: true } });
const megaFalse = await db.anime.count({ where: { inCatalog: true, hasDubMega: false } });
const checked = await db.anime.count({ where: { inCatalog: true, dubThruCheckedAt: { not: null } } });
const thruKnown = await db.anime.count({ where: { inCatalog: true, dubThruS1: { not: null } } });
const probes = await db.dubProbe.count();
console.log(JSON.stringify({ total, mapped, hasDubTrue, hasDubFalse, hasDubNull, megaTrue, megaFalse, checked, thruKnown, probes }, null, 2));

const behind = await db.anime.findMany({
  where: { inCatalog: true, dubThruS1: { not: null, gte: 0 } },
  select: { malId: true, title: true, totalEpisodes: true, dubThruS1: true, dubThruS2: true, hasDub: true, supaplayPath: true },
  take: 10,
  orderBy: { popularity: "asc" },
});
console.log("sample boundary-known:", behind.map((a) => `${a.title} [${a.malId}] s1=${a.dubThruS1}/${a.totalEpisodes} s2=${a.dubThruS2} hasDub=${a.hasDub} mapped=${!!a.supaplayPath}`).join("\n  "));

const jjk = await db.anime.findFirst({
  where: { OR: [{ title: { contains: "Jujutsu" } }, { titleEnglish: { contains: "Jujutsu" } }] },
  select: { malId: true, title: true, totalEpisodes: true, dubThruS1: true, dubThruS2: true, hasDub: true, hasDubMega: true, supaplayPath: true },
});
console.log("JJK:", JSON.stringify(jjk));
await db.$disconnect();
