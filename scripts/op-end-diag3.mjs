/** ep3 envelope profile: where does the black lead end / song start+end NOW? */
import { analyzePlaylist } from "./lib/intro-detect.mjs";

const r = await fetch(`http://localhost:3000/api/stream?malId=21&ep=3&lang=sub`, { signal: AbortSignal.timeout(90_000) });
const j = await r.json();
const res = await analyzePlaylist(j.src, { log: () => {}, minSec: 220, maxSec: 240, keepPcm: true, pcmCapSec: 240 });
if (res.status !== "ok") throw new Error(res.detail);

console.log("ep3 env 0-150 (0.5s windows, # = 0.05 each):");
for (let t = 0; t <= 150; t += 2) {
  const i = Math.round(t / 0.5);
  const v = res.env[i] ?? 0;
  const avg = ((res.env[i] ?? 0) + (res.env[i + 1] ?? 0) + (res.env[i + 2] ?? 0) + (res.env[i + 3] ?? 0)) / 4;
  console.log(`${String(t).padStart(3)} avg=${avg.toFixed(2).padStart(4)} ${"#".repeat(Math.round(Math.min(1.6, v) * 20))}`);
}
console.log("served skip:", JSON.stringify(j.skip));
