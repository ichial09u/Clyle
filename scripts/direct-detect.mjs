import { detectIntro } from "./lib/intro-detect.mjs";

const t0 = Date.now();
const url = process.argv[2] || "https://hls2.aniwatchtv.uk/v/scxqicy/ta9t4m1bhw/cm72fkvbpx/09qmw7k6mi5nzd/master.m3u8";
const v = await detectIntro(url, {
  log: (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`),
});
console.log("VERDICT", JSON.stringify(v));
process.exit(0);
