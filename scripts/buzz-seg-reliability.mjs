/**
 * Sample buzz playlist segment reliability — count how many segs are real TS
 * vs 404/HTML. Usage: node scripts/buzz-seg-reliability.mjs <masterUrl> [step]
 */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const H = { "User-Agent": UA, Referer: "https://megaplay.buzz/" };
const [masterUrl, stepArg] = process.argv.slice(2);
const step = parseInt(stepArg || "12", 10);

const master = await (await fetch(masterUrl, { headers: H, signal: AbortSignal.timeout(20_000) })).text();
const variant = master.split("\n").filter((l) => l.trim() && !l.startsWith("#"))[0];
const vurl = new URL(variant.trim(), masterUrl).href;
const vtext = await (await fetch(vurl, { headers: H, signal: AbortSignal.timeout(20_000) })).text();
const segs = vtext.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
console.log("total segs:", segs.length);

let ok = 0, fail = 0; const fails = [];
for (let i = 0; i < segs.length; i += step) {
  const segUrl = new URL(segs[i].trim(), vurl).href;
  try {
    const res = await fetch(segUrl, { headers: H, signal: AbortSignal.timeout(20_000) });
    const buf = Buffer.from(await res.arrayBuffer());
    const isTs = buf.length > 100_000 && buf[0] === 0x47;
    if (isTs) ok++; else { fail++; fails.push(`#${i + 1}:${res.status}/${buf.length}B`); }
  } catch (e) { fail++; fails.push(`#${i + 1}:ERR`); }
}
console.log(`sampled ok=${ok} fail=${fail} (${Math.round((100 * ok) / (ok + fail))}% ok)`);
if (fails.length) console.log("fails:", fails.join(" "));
