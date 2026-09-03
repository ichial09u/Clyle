/**
 * Test the envelope-matching detector on real prod streams — full fleet flow:
 *   1. establish: analyze ep A + ep B (pair) -> verified interval + reference envelope
 *   2. verify: analyze ep C -> match against the reference -> per-ep interval
 * Usage: node scripts/test-intro-detect.mjs malId epA epB epC
 */
import { analyzePlaylist, matchEnvelope, plausibleInterval } from "./lib/intro-detect.mjs";

const PROD = process.env.PROD_URL || "https://temporary-spry-granite-1f0h7ae.vercel.app";
const [malId, epA = 1, epB = 2, epC = 3] = process.argv.slice(2).map(Number);
const log = (m) => console.log(`  [bot] ${m}`);

async function resolve(ep) {
  const res = await fetch(`${PROD}/api/stream?malId=${malId}&ep=${ep}&lang=sub`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`stream resolve failed: ${res.status}`);
  const s = await res.json();
  return { src: s.src, skip: s.skip };
}

async function grab(ep, maxSec) {
  const t = Date.now();
  const info = await resolve(ep);
  const r = await analyzePlaylist(info.src, { log, maxSec });
  console.log(`ep${ep}: analyzed ${r.analyzedSec.toFixed(0)}s in ${((Date.now() - t) / 1000).toFixed(1)}s wall=${JSON.stringify(r.wall)} | current skip: ${JSON.stringify(info.skip?.intro ?? null)} (${info.skip?.source})`);
  if (r.status !== "ok") throw new Error(`ep${ep} analyze failed: ${r.detail}`);
  return r;
}

// ---- 1) establish from the pair -------------------------------------
const A = await grab(epA, 330);
const B = await grab(epB, 330);

const anchor = A.wall ?? { start: 10, end: Math.min(200, A.analyzedSec - 40) };
const mB = matchEnvelope(B.env, A.env, anchor);
console.log(`\nmatch B: ${JSON.stringify(mB)}`);
if (!mB) { console.log("establish FAILED (B)"); process.exit(1); }

const mA = matchEnvelope(A.env, B.env, mB);
console.log(`match A (refined): ${JSON.stringify(mA)}`);
if (!mA || !plausibleInterval(mA.start, mA.end)) { console.log("establish FAILED (A refine)"); process.exit(1); }

// reference envelope: A's env snippet around the verified interval
const refFrom = Math.max(0, Math.floor(mA.start / 0.5) - 90);
const refTo = Math.min(A.env.length, Math.ceil(mA.end / 0.5) + 40);
const refEnv = A.env.slice(refFrom, refTo);
const refInt = { start: mA.start - refFrom * 0.5, end: mA.end - refFrom * 0.5 };
console.log(`\nREF established: OP ${mA.start}-${mA.end} (refEnv ${refEnv.length} windows, refInt ${JSON.stringify(refInt)})`);

// ---- 2) verify a third episode against the reference ----------------
const C = await grab(epC, Math.min(mA.end + 170, 400));
const mC = matchEnvelope(C.env, refEnv, refInt);
console.log(`\nverify ep${epC}: ${JSON.stringify(mC)} | zoko says ${JSON.stringify((await resolve(epC)).skip?.intro ?? null)}`);
if (mC) console.log(`plausible: ${plausibleInterval(mC.start, mC.end)}, delta vs zoko: start ${Math.abs(mC.start - ((await resolve(epC)).skip?.intro?.start ?? mC.start)).toFixed(1)}s end ${Math.abs(mC.end - ((await resolve(epC)).skip?.intro?.end ?? mC.end)).toFixed(1)}s`);
