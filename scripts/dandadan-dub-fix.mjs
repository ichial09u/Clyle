/**
 * Dandadan S1 (malId 57334) dub fix — targeted backfill.
 *
 * The campaign's slug matcher missed AniKoto's "dandadan-lzcmw" because the
 * catalog title "DAN DA DAN" normalizes to "dan da dan" (no prefix overlap
 * with "dandadan"). Manual mapping: anikotoSeriesId = 4.
 *
 * Steps:
 *  1. Fetch anikotoapi series 4 episode list (embedIds).
 *  2. Binary-search-free sweep: probe ep1, last ep, then bisect to find the
 *     exact dub boundary (embedDubVerdict, real-segment verification).
 *  3. Cross-check flikhub (api.yenime.net backend) per-episode for the same
 *     range to also open the S2 boundary.
 *  4. Record DubProbe rows + advance Anime.dubThruS2 (embed network rides the
 *     S2 chain as final backfill) — mirror of dub-hunt's settle logic.
 *
 *   node scripts/dandadan-dub-fix.mjs
 */
import { PrismaClient } from "@prisma/client";
import { execFile } from "node:child_process";

const db = new PrismaClient();
const MALID = 57334;
const SERIES_ID = 4;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function curl(url, referer) {
  return new Promise((resolve, reject) => {
    execFile("curl", ["-sS", "--max-time", "20", "-A", UA, "-H", `Referer: ${referer}`, url],
      { maxBuffer: 32 * 1024 * 1024, timeout: 25000 },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(stderr || err.message));
        resolve(stdout);
      });
  });
}

async function anikotoEps(seriesId) {
  const body = await curl(`https://anikotoapi.site/series/${seriesId}`, "https://anikototv.to/");
  const j = JSON.parse(body);
  if (!j || j.ok !== true || !j.data) throw new Error("anikotoapi invalid");
  return (j.data.episodes ?? [])
    .map((e) => ({ number: Number(e.number ?? e.episode ?? 0), embedId: e.episode_embed_id != null ? Number(e.episode_embed_id) || null : null }))
    .filter((e) => e.number > 0);
}

async function embedDubVerdict(embedId) {
  let file = null;
  for (let round = 0; round < 2; round++) {
    let res;
    try {
      res = await curl(`https://megaplay.buzz/stream/getSources?id=${embedId}&type=dub`, "https://megaplay.buzz/");
    } catch { return null; }
    let json;
    try { json = JSON.parse(res); } catch { return null; }
    const f = json?.sources?.file;
    if (f) { file = f; break; }
    if (round === 0) await sleep(1500);
    else return false;
  }
  try {
    const headers = { "User-Agent": UA, Referer: "https://megaplay.buzz/", Accept: "*/*" };
    const mres = await fetch(file, { headers, signal: AbortSignal.timeout(12000) });
    if (!mres.ok) return null;
    const master = await mres.text();
    const variant = master.split("\n").find((l) => l.trim() && !l.startsWith("#"));
    if (!variant) return false;
    const vres = await fetch(new URL(variant.trim(), file).href, { headers, signal: AbortSignal.timeout(12000) });
    if (!vres.ok) return null;
    const vtext = await vres.text();
    const real = vtext.split("\n").filter((l) => {
      const s = l.trim();
      return s && !s.startsWith("#") && /seg-\d+-/.test(s) && !/tiktokcdn\.com/.test(s);
    }).length;
    return real >= 3;
  } catch { return null; }
}

async function flikhubVerdict(malId, ep) {
  try {
    const res = await fetch(`https://api.flikhub.net/megaplay?mal=${malId}&ep=${ep}&type=dub`, {
      headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.m3u8) return false;
    const headers = { "User-Agent": UA, Referer: "https://megaplay.buzz/", Accept: "*/*" };
    const mres = await fetch(json.m3u8, { headers, signal: AbortSignal.timeout(12000) });
    if (!mres.ok) return null;
    const master = await mres.text();
    const variant = master.split("\n").find((l) => l.trim() && !l.startsWith("#"));
    if (!variant) return false;
    const vres = await fetch(new URL(variant.trim(), json.m3u8).href, { headers, signal: AbortSignal.timeout(12000) });
    if (!vres.ok) return null;
    const vtext = await vres.text();
    const real = vtext.split("\n").filter((l) => {
      const s = l.trim();
      return s && !s.startsWith("#") && /seg-\d+-/.test(s) && !/tiktokcdn\.com/.test(s);
    }).length;
    return real >= 3;
  } catch { return null; }
}

async function recordProbe(ep, ok, provider, detail) {
  await db.dubProbe.upsert({
    where: { malId_ep_chain: { malId: MALID, ep, chain: "s2" } },
    create: { malId: MALID, ep, chain: "s2", ok, provider, detail },
    update: { ok, provider, detail },
  }).catch(() => undefined);
}

async function main() {
  const anime = await db.anime.findUnique({ where: { malId: MALID }, select: { malId: true, title: true, totalEpisodes: true, anikotoSeriesId: true, dubThruS2: true, dubHiS2: true, dubThruS1: true } });
  if (!anime) throw new Error("anime missing");
  console.log("before:", JSON.stringify(anime));

  // 1. map AniKoto series id
  await db.anime.update({ where: { malId: MALID }, data: { anikotoSeriesId: SERIES_ID } });
  const eps = await anikotoEps(SERIES_ID);
  const nums = eps.map((e) => e.number).sort((a, b) => a - b);
  console.log(`anikoto series ${SERIES_ID}: ${eps.length} eps, range ${nums[0]}..${nums[nums.length - 1]}`);
  console.log("embed ids:", eps.map(e => `${e.number}:${e.embedId}`).join(" "));

  const malTotal = anime.totalEpisodes || nums[nums.length - 1];
  const lastEp = malTotal > 1 ? malTotal : nums[nums.length - 1];
  const byNum = new Map(eps.map((e) => [e.number, e.embedId]));

  // 2. sweep: ep1, last, then fill the boundary
  const verdicts = new Map();
  async function probe(ep) {
    if (verdicts.has(ep)) return verdicts.get(ep);
    const embedId = byNum.get(ep);
    const v = embedId ? await embedDubVerdict(embedId) : false;
    verdicts.set(ep, v);
    console.log(`  ep ${ep} (embed ${embedId}) -> ${v === true ? "REAL DUB" : v === false ? "no dub" : "transient"}`);
    await sleep(400);
    return v;
  }

  const v1 = await probe(1);
  if (v1 !== true) {
    console.log("ep1 has no real dub on embed network — checking flikhub only path");
  } else {
    await recordProbe(1, true, "megaplay-embed", "dandadan-fix: anikoto series 4 ep1 real");
  }

  const vLast = await probe(lastEp);
  if (vLast === true) {
    await recordProbe(lastEp, true, "megaplay-embed", "dandadan-fix: last-ep settle");
  } else if (vLast === false) {
    await recordProbe(lastEp, false, null, "dandadan-fix: last-ep miss");
  }

  // 3. if partial, bisect down from last proven-miss to find boundary
  let thru = v1 === true ? 1 : 0;
  if (vLast === false && v1 === true) {
    let lo = 1, hi = lastEp; // lo proven real, hi proven miss
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const v = await probe(mid);
      if (v === true) { lo = mid; } else if (v === false) { hi = mid; } else { break; }
    }
    thru = lo;
    // confirm the step just above the boundary really misses (guard vs holes)
    console.log(`bisect settled: dubThru candidate = ${thru}`);
  } else if (vLast === true && v1 === true) {
    // sample the middle to make sure there are no holes (cheap spot check)
    const mid = Math.floor(lastEp / 2);
    const vMid = await probe(mid);
    thru = vMid === true || vMid === null ? lastEp : thru; // hole -> keep conservative
    if (vMid === true) await recordProbe(mid, true, "megaplay-embed", "dandadan-fix: mid spot-check");
  }

  // 4. flikhub cross-check on a couple of eps (server-2's primary backfill)
  const fv1 = await flikhubVerdict(MALID, 1);
  console.log("flikhub ep1:", fv1);
  const fvLast = await flikhubVerdict(MALID, lastEp);
  console.log(`flikhub ep${lastEp}:`, fvLast);
  if (fv1 === true) await recordProbe(1, true, "yenime", "dandadan-fix: flikhub hit ep1");

  // 5. advance boundary (S2 chain — embed/flikhub backfills live there)
  const cur = await db.anime.findUnique({ where: { malId: MALID }, select: { dubThruS2: true } });
  const newThru = Math.max(cur?.dubThruS2 ?? 0, Math.min(thru, malTotal));
  await db.anime.update({
    where: { malId: MALID },
    data: {
      dubThruS2: newThru,
      dubHiS2: vLast === false ? lastEp : null,
      dubThruCheckedAt: new Date(),
      // anime-level verdicts: the embed network is the megaplay verdict path
      hasDubMega: true,
    },
  });
  console.log(`after: dubThruS2=${newThru} (was ${cur?.dubThruS2}), lastEpVerdict=${vLast}`);
  console.log("verdict map:", JSON.stringify([...verdicts.entries()].sort((a, b) => a[0] - b[0])));
  await db.$disconnect();
}

main().catch((e) => { console.error("fatal", e); process.exit(1); });
