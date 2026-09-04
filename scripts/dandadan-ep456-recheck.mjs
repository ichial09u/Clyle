/**
 * Re-verify Dandadan eps 4-6 through the buzz-page path with the dub-hunt
 * rule: getSources intermittently answers empty — a single "no file" is NOT
 * proof. Two agreeing attempts (with backoff) required for a definitive
 * miss; and every positive file is segment-verified.
 */
import { PrismaClient } from "@prisma/client";
import { execFile } from "node:child_process";

const db = new PrismaClient();
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function curl(url) {
  return new Promise((resolve, reject) => {
    execFile("curl", ["-sS", "--max-time", "20", "-A", UA, "-H", "Referer: https://megaplay.buzz/", url],
      { maxBuffer: 32 * 1024 * 1024, timeout: 25000 },
      (err, stdout, stderr) => (err && !stdout ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });
}

async function realSegmentCount(masterUrl) {
  try {
    const headers = { "User-Agent": UA, Referer: "https://megaplay.buzz/", Accept: "*/*" };
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
  } catch { return null; }
}

async function buzzVerdict(ep) {
  const html = await curl(`https://megaplay.buzz/stream/mal/57334/${ep}/dub`);
  const m = html.match(/data-id="(\d+)"/);
  if (!m) return { dataId: null, verdict: false, real: 0 };
  // two agreeing attempts (dub-hunt rule)
  let file = null, misses = 0;
  for (let round = 0; round < 2; round++) {
    const body = await curl(`https://megaplay.buzz/stream/getSources?id=${m[1]}&type=dub`);
    try {
      const json = JSON.parse(body);
      const f = json?.sources?.file;
      if (f) { file = f; break; }
    } catch { /* transient */ }
    misses++;
    if (round === 0) await sleep(2000);
  }
  if (!file) return { dataId: m[1], verdict: false, real: 0, agreeingMisses: misses };
  const real = await realSegmentCount(file);
  return { dataId: m[1], verdict: real != null && real >= 3, real };
}

async function main() {
  for (const ep of [4, 5, 6]) {
    const v = await buzzVerdict(ep);
    console.log(`ep ${ep}:`, JSON.stringify(v));
    await sleep(500);
  }
  // also re-check 1..12 quickly to rebuild the true verdict map
  console.log("\nfull re-sweep with 2-attempt rule:");
  const dubbed = [];
  for (let ep = 1; ep <= 12; ep++) {
    const v = await buzzVerdict(ep);
    if (v.verdict) dubbed.push(ep);
    console.log(`ep ${ep}: ${v.verdict ? "REAL" : "no"} (id ${v.dataId}, real ${v.real})`);
    await sleep(400);
  }
  console.log("dubbed:", dubbed.sort((a, b) => a - b).join(","));
  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
