/**
 * Diagnostic: ep1 vs ep2 vs ep3 — envelope + PCM correlation around the
 * contested OP end (~97.5 visual vs ~111 audio-matched). Find what actually
 * separates the song's end from the shared post-OP title-card audio.
 */
import { analyzePlaylist } from "./lib/intro-detect.mjs";

const srcCache = {};
async function getSrc(ep) {
  if (srcCache[ep]) return srcCache[ep];
  const r = await fetch(`http://localhost:3000/api/stream?malId=21&ep=${ep}&lang=sub`, { signal: AbortSignal.timeout(90_000) });
  const j = await r.json();
  srcCache[ep] = j.src;
  return j.src;
}

async function watch(ep) {
  const src = await getSrc(ep);
  const r = await analyzePlaylist(src, { log: () => {}, minSec: 200, maxSec: 220, keepPcm: true, pcmCapSec: 220 });
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

const [A, B] = [await watch(1), await watch(2)];

console.log("t  | env1 env2 | pcmCorr(2.5s blocks, aligned at OP start)");
for (let t = 88; t <= 122; t += 1) {
  const i = Math.round(t / 0.5);
  const bar = (v) => "#".repeat(Math.round(Math.min(1.5, v) * 20)).padEnd(30);
  const c = pcmCorr(A.pcm, t * 8000, B.pcm, t * 8000, 2.5 * 8000); // aligned (same OP start both)
  console.log(`${String(t).padStart(3)} | ${bar(A.env[i])}| ${bar(B.env[i])}| ${c.toFixed(3)}`);
}
