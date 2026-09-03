/**
 * Spot-check: do anime marked hasDubMega=false (or hasDub=false) actually
 * have REAL dub on flikhub megaplay (yenime) right now? Pick popular shows
 * with no dub verdict and probe them fresh.
 */
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// flikhub megaplay: master m3u8 -> first variant -> count real segs
async function megaReal(malId, ep = 1) {
  try {
    const res = await fetch(`https://api.flikhub.net/megaplay?mal=${malId}&ep=${ep}&type=dub`, {
      headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return `http${res.status}`;
    const json = await res.json();
    if (!json.m3u8) return "no-m3u8";
    const headers = { "User-Agent": UA, Referer: "https://megaplay.buzz/", Accept: "*/*" };
    const mres = await fetch(json.m3u8, { headers, signal: AbortSignal.timeout(12000) });
    if (!mres.ok) return `master${mres.status}`;
    const master = await mres.text();
    const variant = master.split("\n").find((l) => l.trim() && !l.startsWith("#"));
    if (!variant) return "no-variant";
    const vres = await fetch(new URL(variant.trim(), json.m3u8).href, { headers, signal: AbortSignal.timeout(12000) });
    if (!vres.ok) return `variant${vres.status}`;
    const vtext = await vres.text();
    const real = vtext.split("\n").filter((l) => {
      const s = l.trim();
      return s && !s.startsWith("#") && /seg-\d+-/.test(s) && !/tiktokcdn\.com/.test(s);
    }).length;
    return real >= 3 ? `REAL(${real} segs)` : `stub(${real} real segs)`;
  } catch (e) {
    return `err:${String(e).slice(0, 40)}`;
  }
}

// JJK S2 = MAL 51009; also grab popular hasDubMega=false anime
const jjk2 = await db.anime.findUnique({
  where: { malId: 51009 },
  select: { malId: true, title: true, totalEpisodes: true, dubThruS1: true, dubThruS2: true, hasDub: true, hasDubMega: true, dubHiS1: true },
});
console.log("JJK S2 (51009):", JSON.stringify(jjk2));

const suspects = await db.anime.findMany({
  where: { inCatalog: true, OR: [{ hasDubMega: false }, { hasDubMega: null }], hasDub: false },
  orderBy: { popularity: "asc" },
  take: 15,
  select: { malId: true, title: true, popularity: true, hasDub: true, hasDubMega: true },
});
console.log(`\nprobing ${suspects.length} popular no-dub anime against flikhub megaplay:`);
for (const a of suspects) {
  const v = await megaReal(a.malId);
  console.log(`  ${a.title} [${a.malId}] pop=${a.popularity} hasDubMega=${a.hasDubMega} -> ${v}`);
}
await db.$disconnect();
