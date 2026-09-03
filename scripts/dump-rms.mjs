/**
 * Dump the 0.5s RMS energy profile of an episode's first minutes as ASCII,
 * so the detector's thresholds can be tuned against real data.
 * Usage: node scripts/dump-rms.mjs <masterUrl> [seconds]
 */
import { spawn } from "node:child_process";

const url = process.argv[2];
const secs = Number(process.argv[3] || 200);

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const headers = { "User-Agent": UA, Origin: "https://zokoanime.video", Referer: "https://zokoanime.video/" };

const mres = await fetch(url, { headers });
const master = await mres.text();
const variantLine = master.split("\n").find((l) => l.trim() && !l.startsWith("#"));
const vurl = new URL(variantLine.trim(), url).href;
const vres = await fetch(vurl, { headers });
const vtext = await vres.text();
const segs = [];
let pend = null;
for (const line of vtext.split("\n")) {
  const t = line.trim();
  if (t.startsWith("#EXTINF:")) pend = parseFloat(t.slice(8));
  else if (t && !t.startsWith("#")) { segs.push({ url: new URL(t, vurl).href, dur: pend }); pend = null; }
  if (segs.reduce((a, s) => a + s.dur, 0) >= secs) break;
}

const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-map", "0:a:0?", "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], { stdio: ["pipe", "pipe", "inherit"] });
const rms = [];
let buf = Buffer.alloc(0);
child.stdout.on("data", (chunk) => {
  buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
  const win = 4000;
  const n = Math.floor(buf.length / 2);
  const usable = n - (n % win);
  for (let w = 0; w < usable; w += win) {
    let sum = 0;
    for (let i = 0; i < win; i++) { const v = buf.readInt16LE((w + i) * 2); sum += v * v; }
    rms.push(Math.sqrt(sum / win));
  }
  buf = buf.subarray(usable * 2);
});
(async () => {
  for (const seg of segs) {
    const res = await fetch(seg.url, { headers });
    const ab = Buffer.from(await res.arrayBuffer());
    if (!child.stdin.write(ab)) await new Promise((r) => child.stdin.once("drain", r));
  }
  child.stdin.end();
})();

setTimeout(() => {
  const sorted = [...rms].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  console.log(`windows: ${rms.length} (${(rms.length * 0.5).toFixed(0)}s), p95=${p95.toFixed(0)}`);
  // print one char per window: ' '=near-silent, '.'=quiet, '-'=mid, '='=loud, '#'=very loud (relative to p95)
  const rel = (v) => v / p95;
  for (let i = 0; i < rms.length; i += 1) {
    if (i % 120 === 0) process.stdout.write(`\n${String((i * 0.5)).padStart(5)}s `);
    const r = rel(rms[i]);
    process.stdout.write(r < 0.03 ? " " : r < 0.1 ? "." : r < 0.3 ? "-" : r < 0.6 ? "=" : "#");
  }
  console.log(`\n`);
  console.log(`legend: ' '=near-silent ' '=quiet '.'=quiet '-'=mid '='=loud '#'=very loud (rel to p95=${p95.toFixed(0)})`);
  process.exit(0);
}, 25000);
