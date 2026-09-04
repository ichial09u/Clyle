/**
 * Dandadan S1 (malId 57334) — full-season dub sweep via the megaplay.buzz
 * mal-keyed page path.
 *
 * Discovery: flikhub's mal-keyed API answers an AD-STUB m3u8 for Dandadan
 * (tiktokcdn ad segments only), but megaplay.buzz's own stream page
 * (https://megaplay.buzz/stream/mal/{malId}/{ep}/dub) exposes a per-episode
 * `data-id` whose getSources serves a REAL 1080p dub playlist
 * (cdn.kryntal.top, 358 real segments at ep 1). This script sweeps all
 * episodes through that path, verifies real segments, and records:
 *   - DubProbe rows (chains s1 + s2, provider "megaplay-buzz")
 *   - Anime.dubThruS1/S2 boundary advance + dubThruCheckedAt
 *   - Anime.hasDubMega = true (the megaplay network DOES carry the dub)
 *
 *   node scripts/dandadan-dub-sweep.mjs
 */
import { PrismaClient } from "@prisma/client";
import { execFile } from "node:child_process";

const db = new PrismaClient();
const MALID = 57334;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const REF = "https://megaplay.buzz/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function curl(url, extra = []) {
  return new Promise((resolve, reject) => {
    execFile("curl", ["-sS", "--max-time", "20", "-A", UA, "-H", `Referer: ${REF}`, ...extra, url],
      { maxBuffer: 32 * 1024 * 1024, timeout: 25000 },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(stderr || err.message));
        resolve(stdout);
      });
  });
}

async function dataIdForEp(ep) {
  const html = await curl(`https://megaplay.buzz/stream/mal/${MALID}/${ep}/dub`);
  const m = html.match(/data-id="(\d+)"/);
  return m ? parseInt(m[1], 10) : null;
}

async function getSources(embedId, type = "dub") {
  const body = await curl(`https://megaplay.buzz/stream/getSources?id=${embedId}&type=${type}`);
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** real-dub verdict: master -> first variant -> count real seg lines */
async function realSegmentCount(masterUrl) {
  try {
    const headers = { "User-Agent": UA, Referer: REF, Accept: "*/*" };
    const mres = await fetch(masterUrl, { headers, signal: AbortSignal.timeout(12000) });
    if (!mres.ok) return null;
    const master = await mres.text();
    const variant = master.split("\n").find((l) => l.trim() && !l.startsWith("#"));
    if (!variant) return 0;
    const vres = await fetch(new URL(variant.trim(), masterUrl).href, { headers, signal: AbortSignal.timeout(12000) });
    if (!vres.ok) return null;
    const vtext = await vres.text();
    return vtext.split("\n").filter((l) => {
      const s = l.trim();
      return s && !s.startsWith("#") && /seg-\d+-/.test(s) && !/tiktokcdn\.com/.test(s);
    }).length;
  } catch {
    return null;
  }
}

async function recordProbe(ep, ok, provider, detail, chain) {
  await db.dubProbe.upsert({
    where: { malId_ep_chain: { malId: MALID, ep, chain } },
    create: { malId: MALID, ep, chain, ok, provider, detail },
    update: { ok, provider, detail },
  }).catch(() => undefined);
}

async function main() {
  const anime = await db.anime.findUnique({
    where: { malId: MALID },
    select: { malId: true, title: true, totalEpisodes: true, dubThruS1: true, dubThruS2: true, dubHiS1: true, dubHiS2: true },
  });
  if (!anime) throw new Error("anime missing");
  console.log("before:", JSON.stringify(anime));
  const total = anime.totalEpisodes || 12;

  const results = [];
  for (let ep = 1; ep <= total; ep++) {
    const dataId = await dataIdForEp(ep);
    if (!dataId) {
      results.push({ ep, dataId: null, verdict: false, real: 0 });
      console.log(`ep ${ep}: no data-id -> no dub`);
      await sleep(300);
      continue;
    }
    const json = await getSources(dataId);
    const file = json?.sources?.file;
    if (!file) {
      results.push({ ep, dataId, verdict: false, real: 0 });
      console.log(`ep ${ep} (id ${dataId}): getSources no file -> no dub`);
      await sleep(300);
      continue;
    }
    const real = await realSegmentCount(file);
    const verdict = real != null && real >= 3;
    results.push({ ep, dataId, verdict, real, file });
    console.log(`ep ${ep} (id ${dataId}): ${verdict ? "REAL DUB" : "stub/none"} (${real ?? "?"} real segs) ${file.slice(0, 80)}`);
    await sleep(400);
  }

  const dubbed = results.filter((r) => r.verdict).map((r) => r.ep);
  const highest = dubbed.length ? Math.max(...dubbed) : 0;
  console.log(`\ndubbed eps: [${dubbed.sort((a, b) => a - b).join(", ")}]  highest=${highest}`);

  // record probes + boundaries (S2 chain where megaplay is the backfill;
  // S1 chain also falls through to megaplay after supaplay)
  for (const r of results) {
    for (const chain of ["s1", "s2"]) {
      await recordProbe(r.ep, r.verdict, r.verdict ? "megaplay-buzz" : null, r.verdict ? `dandadan sweep: id ${r.dataId}, ${r.real} real segs` : `dandadan sweep: no real dub (id ${r.dataId ?? "none"})`, chain);
    }
  }

  const cur = await db.anime.findUnique({ where: { malId: MALID }, select: { dubThruS1: true, dubThruS2: true } });
  const data = { dubThruCheckedAt: new Date() };
  if (highest > 0) {
    data.dubThruS1 = Math.max(cur?.dubThruS1 ?? 0, Math.min(highest, total));
    data.dubThruS2 = Math.max(cur?.dubThruS2 ?? 0, Math.min(highest, total));
    data.hasDubMega = true;
  } else {
    data.dubHiS1 = Math.min(anime.dubHiS1 ?? total, total);
    data.dubHiS2 = Math.min(anime.dubHiS2 ?? total, total);
  }
  await db.anime.update({ where: { malId: MALID }, data });
  console.log("after:", JSON.stringify(data));
  await db.$disconnect();
}

main().catch((e) => { console.error("fatal", e); process.exit(1); });
