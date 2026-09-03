#!/usr/bin/env node
/**
 * Batch-probe the megaplay (yenime/flikhub) DUB source for every catalog
 * anime where Zoko AND Kiwi both lack a real dub (hasDub=false,
 * hasDubKiwi=false), and persist the verdict into Anime.hasDubMega.
 *
 * Verdict logic = the same real-dub check the runtime uses: fetch the dub
 * master -> first variant -> count REAL `seg-N-` video segments
 * (megaplay serves an ad-stub playlist with zero real segments for
 * episodes it doesn't actually have in English).
 *
 * Resumable: animes with a non-null hasDubMega are skipped. Run:
 *   node scripts/probe-megaplay-dub.mjs [--limit N] [--only 40748,51009]
 */
import { PrismaClient } from "@prisma/client";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36";
const REFERER = "https://megaplay.buzz/";
const FLIKHUB = "https://api.flikhub.net";

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const limit = flag("--limit") ? parseInt(flag("--limit"), 10) : Infinity;
const only = flag("--only") ? flag("--only").split(",").map(Number) : null;

async function segCount(masterUrl) {
  const headers = { "User-Agent": UA, Referer: REFERER };
  const m = await fetch(masterUrl, { headers, signal: AbortSignal.timeout(15000) });
  if (!m.ok) return null;
  const master = await m.text();
  const variant = master.split("\n").find((l) => l.trim() && !l.startsWith("#"));
  if (!variant) return 0;
  const v = await fetch(new URL(variant.trim(), masterUrl).href, { headers, signal: AbortSignal.timeout(15000) });
  if (!v.ok) return null;
  const text = await v.text();
  return text
    .split("\n")
    .filter((l) => {
      const s = l.trim();
      return s && !s.startsWith("#") && /seg-\d+-/.test(s) && !/tiktokcdn\.com/.test(s);
    }).length;
}

/** true = real dub, false = definitive no/stub, null = transient trouble */
async function probe(malId, ep = 1) {
  try {
    const res = await fetch(`${FLIKHUB}/megaplay?mal=${malId}&ep=${ep}&type=dub`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 404) return false; // flikhub: unknown anime
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.m3u8) return false;
    const n = await segCount(json.m3u8);
    if (n == null) return null;
    return n >= 3;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const where = only
    ? { malId: { in: only } }
    : { hasDub: false, hasDubKiwi: false, hasDubMega: null, inCatalog: true };
  const animes = await prisma.anime.findMany({
    where,
    orderBy: { popularity: "asc" },
    take: Number.isFinite(limit) ? limit : undefined,
    select: { malId: true, title: true, titleEnglish: true },
  });

  console.log(`[probe-megaplay-dub] target: ${animes.length} animes`);
  let real = 0;
  let absent = 0;
  let unsure = 0;

  for (let i = 0; i < animes.length; i++) {
    const a = animes[i];
    const verdict = await probe(a.malId);
    const label = a.titleEnglish?.trim() || a.title;
    if (verdict === true) {
      real++;
      await prisma.anime.update({ where: { malId: a.malId }, data: { hasDubMega: true } }).catch(() => undefined);
      console.log(`[${i + 1}/${animes.length}] REAL DUB  ${a.malId}  ${label}`);
    } else if (verdict === false) {
      absent++;
      await prisma.anime.update({ where: { malId: a.malId }, data: { hasDubMega: false } }).catch(() => undefined);
      if ((i + 1) % 25 === 0) console.log(`[${i + 1}/${animes.length}] probed… (real=${real} none=${absent} unsure=${unsure})`);
    } else {
      unsure++;
      console.log(`[${i + 1}/${animes.length}] unsure (network) — left unprobed: ${a.malId} ${label}`);
    }
    await sleep(250);
  }

  console.log(`[probe-megaplay-dub] done: real=${real} none=${absent} unsure=${unsure}`);
}

main()
  .catch((e) => {
    console.error("[probe-megaplay-dub] fatal:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
