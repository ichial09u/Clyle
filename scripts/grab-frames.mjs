/**
 * Grab video frames from an episode at given timestamps (ground-truth checks).
 * Usage: node scripts/grab-frames.mjs malId ep t1 t2 t3 ...
 */
import { analyzePlaylist } from "./lib/intro-detect.mjs";
import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";

const PROD = process.env.PROD_URL || "https://temporary-spry-granite-1f0h7ae.vercel.app";
const [malId, ep, ...targets] = process.argv.slice(2).map(Number);

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const headers = { "User-Agent": UA, Origin: "https://zokoanime.video", Referer: "https://zokoanime.video/" };

const res = await fetch(`${PROD}/api/stream?malId=${malId}&ep=${ep}&lang=sub`);
if (!res.ok) { console.error("resolve failed", res.status); process.exit(1); }
const s = await res.json();

const mres = await fetch(s.src, { headers });
const master = await mres.text();
const v = master.split("\n").find((l) => l.trim() && !l.startsWith("#")).trim();
const vurl = new URL(v, s.src).href;
const vres = await fetch(vurl, { headers });
const vt = await vres.text();
const segs = [];
let pend = null;
for (const line of vt.split("\n")) {
  const t = line.trim();
  if (t.startsWith("#EXTINF:")) pend = parseFloat(t.slice(8));
  else if (t && !t.startsWith("#")) { segs.push({ url: new URL(t, vurl).href, dur: pend }); pend = null; }
}

let acc = 0;
const spans = segs.map((sg) => { const s0 = acc; acc += sg.dur; return { s0, s1: acc, url: sg.url }; });
for (const tt of targets) {
  // bundle the segments covering [t-4, t+4] into one file so -ss can seek
  const need = spans.filter((sp) => sp.s1 > tt - 4 && sp.s0 < tt + 4);
  if (!need.length) continue;
  let bytes = [];
  for (const sp of need) {
    const r = await fetch(sp.url, { headers });
    bytes.push(Buffer.from(await r.arrayBuffer()));
  }
  await writeFile("/tmp/frame-seg.ts", Buffer.concat(bytes));
  const off = tt - need[0].s0;
  await new Promise((done) => {
    const f = spawn("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(off), "-i", "/tmp/frame-seg.ts", "-frames:v", "1", "-vf", "scale=480:-1", `/tmp/frame-${malId}-${ep}-${tt}.png`], { stdio: ["ignore", "ignore", "inherit"] });
    f.on("close", done);
    f.on("error", () => done());
  });
  console.log(`frame t=${tt}s -> /tmp/frame-${malId}-${ep}-${tt}.png`);
}
process.exit(0);
