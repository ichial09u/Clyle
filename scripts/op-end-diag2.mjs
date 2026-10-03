/** ep2 vs ep3 aligned at song start (0.3 vs ~22.3): find ep3's true song end. */
import { analyzePlaylist } from "./lib/intro-detect.mjs";

async function getSrc(ep) {
  const r = await fetch(`http://localhost:3000/api/stream?malId=21&ep=${ep}&lang=sub`, { signal: AbortSignal.timeout(90_000) });
  const j = await r.json();
  return j.src;
}
async function watch(ep) {
  const src = await getSrc(ep);
  const r = await analyzePlaylist(src, { log: () => {}, minSec: 220, maxSec: 240, keepPcm: true, pcmCapSec: 240 });
  if (r.status !== "ok") throw new Error(r.detail);
  return r;
}
function pcmCorr(a, ai, b, bi, len) {
  if (ai < 0 || bi < 0 || ai + len > a.length || bi + len > b.length) return 0;
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < len; i++) { const x = a[ai+i], y = b[bi+i]; sa += x; sb += y; saa += x*x; sbb += y*y; sab += x*y; }
  const num = len * sab - sa * sb;
  const den = Math.sqrt((len * saa - sa * sa) * (len * sbb - sb * sb) + 1e-9);
  return den > 0 ? num / den : 0;
}

const [B, C] = [await watch(2), await watch(3)];
const OFF = 22.3; // ep3 song start estimate
// micro-align ep3 against ep2 at song position 40 (mid-song, guaranteed)
let bestShift = 0, bestC = -1;
for (let s = -1.5; s <= 1.5; s += 0.25) {
  const c = pcmCorr(C.pcm, Math.round((40 + OFF + s) * 8000), B.pcm, Math.round(40 * 8000), 3 * 8000);
  if (c > bestC) { bestC = c; bestShift = s; }
}
console.log(`mid-song corr at 40s: ${bestC.toFixed(3)} (shift ${bestShift})`);

console.log("songPos | ep2t ep3t | env2 env3 | corr(1.5s)");
for (let p = 60; p <= 140; p += 1) {
  const t2 = p, t3 = p + OFF + bestShift;
  const c = pcmCorr(B.pcm, Math.round(t2 * 8000), C.pcm, Math.round(t3 * 8000), 1.5 * 8000);
  const i2 = Math.round(t2 / 0.5), i3 = Math.round(t3 / 0.5);
  const e2 = B.env[i2]?.toFixed(2).padStart(4) ?? "  - ";
  const e3 = C.env[i3]?.toFixed(2).padStart(4) ?? "  - ";
  console.log(`${String(p).padStart(3)} | ${String(t2.toFixed(0)).padStart(4)} ${String(t3.toFixed(0)).padStart(4)} | ${e2} ${e3} | ${c.toFixed(3)}`);
}
