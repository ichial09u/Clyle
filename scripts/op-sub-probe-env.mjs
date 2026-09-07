// probe one episode's loud-block structure (diagnostic)
import { analyzePlaylist, matchEnvelope, plausibleInterval } from "./lib/intro-detect.mjs";

const ep = parseInt(process.argv[2] ?? "300", 10);
const partner = parseInt(process.argv[3] ?? "0", 10);

async function resolve(ep) {
  const res = await fetch(`http://localhost:3000/api/stream?malId=21&ep=${ep}&lang=sub&server=1`, { signal: AbortSignal.timeout(75_000) });
  const s = await res.json();
  return s.src;
}

function blocks(env) {
  const loud = env.map((v) => v >= 0.5);
  const out = [];
  let i = 0;
  while (i < loud.length) {
    if (!loud[i]) { i++; continue; }
    let j = i;
    while (j < loud.length && (loud[j] || (j + 2 < loud.length && (loud[j + 1] || loud[j + 2])))) j++;
    out.push({ start: i * 0.5, end: (j + 1) * 0.5, dur: (j + 1 - i) * 0.5 });
    i = j + 1;
  }
  return out.filter((b) => b.dur >= 15);
}

const src = await resolve(ep);
const r = await analyzePlaylist(src, { log: () => {}, maxSec: 330, minSec: 300 });
console.log(`ep${ep}: status=${r.status} analyzed=${r.analyzedSec.toFixed(0)}s wall=${JSON.stringify(r.wall)}`);
console.log(`ep${ep} loud blocks (>=15s):`, JSON.stringify(blocks(r.env)));
if (partner) {
  const src2 = await resolve(partner);
  const r2 = await analyzePlaylist(src2, { log: () => {}, maxSec: 330, minSec: 300 });
  console.log(`ep${partner}: status=${r2.status} wall=${JSON.stringify(r2.wall)}`);
  console.log(`ep${partner} loud blocks:`, JSON.stringify(blocks(r2.env)));
  const anchors = [...(r.wall ? [r.wall] : []), loudestSpan(r.env)].filter(Boolean);
  for (const a of anchors) {
    const t = matchEnvelope(r2.env, r.env, a);
    const back = t ? matchEnvelope(r.env, r2.env, t) : null;
    console.log(`anchor ${JSON.stringify(a)} -> t=${JSON.stringify(t)} back=${JSON.stringify(back)} plausible=${t ? plausibleInterval(t.start, t.end) : "-"}`);
  }
  const ls = loudestSpan(r2.env);
  const t2 = matchEnvelope(r.env, r2.env, ls);
  console.log(`reverse anchor ${JSON.stringify(ls)} -> ${JSON.stringify(t2)}`);
}
function loudestSpan(env, spanSec = 70) {
  const span = Math.floor(spanSec / 0.5);
  if (env.length <= span) return env.length ? { start: 0, end: env.length * 0.5 } : null;
  let bestI = 0, bestSum = -1, sum = 0;
  for (let i = 0; i < env.length; i++) {
    sum += env[i];
    if (i >= span) sum -= env[i - span];
    if (i >= span - 1 && sum > bestSum) { bestSum = sum; bestI = i - span + 1; }
  }
  return { start: bestI * 0.5, end: (bestI + span) * 0.5 };
}
process.exit(0);
