import { analyzePlaylist } from "./lib/intro-detect.mjs";
const src = "https://hls2.aniwatchtv.uk/v/scxqicy/5aygnsqc0o/rhds3ekx1o/07atoz1yygf70u/master.m3u8";
console.log("analyzing BLEACH ep1...");
const t0 = Date.now();
const r = await analyzePlaylist(src, { log: (m) => console.log("  [log]", m), maxSec: 200, minSec: 150 });
console.log(`status=${r.status} analyzedSec=${r.analyzedSec} envLen=${r.env.length} wall=${JSON.stringify(r.wall)} detail=${r.detail} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
if (r.env.length) console.log("env head:", r.env.slice(0, 20).join(","));
