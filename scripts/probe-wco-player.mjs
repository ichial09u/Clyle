#!/usr/bin/env node
/** Fetch the WCO video-js player page for an episode and grep for caption tracks. */
import { execFile } from "node:child_process";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
function curl(url, referer) {
  return new Promise((resolve) => {
    const args = ["-sS", "--max-time", "20", "-A", UA, "--compressed", "-w", "\n__STATUS__%{http_code}", url];
    if (referer) args.push("-e", referer);
    execFile("curl", args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      const m = stdout.match(/__STATUS__(\d+)\s*$/);
      resolve({ status: m ? +m[1] : 0, body: stdout.replace(/__STATUS__\d+\s*$/, "") });
    });
  });
}

const slug = process.argv[2];
const page = await curl(`https://www.wcostream.tv/${slug}`);
if (page.status !== 200) { console.log(`page ${page.status}`); process.exit(1); }
const src = page.body.match(/https:\/\/embed\.wcostream\.com\/inc\/embed\/index\.php\?[^"]+/)?.[0];
if (!src) { console.log("no iframe"); process.exit(1); }
const vjs = src.replace("/index.php?", "/video-js.php?");
console.log(`vjs: ${vjs.slice(0, 110)}...`);
const pl = await curl(vjs, "https://embed.wcostream.com/inc/embed/index.php");
console.log(`player page: ${pl.status} len=${pl.body.length}`);
// caption-ish markers
for (const re of [/<track[^>]*>/gi, /captions?/gi, /subtitle/gi, /\.vtt/gi, /sub_info/gi, /["']sub["']/gi, /getsub/gi, /cc[_-]/gi]) {
  const hits = pl.body.match(re);
  if (hits?.length) console.log(`  ${re}: ${hits.length} -> ${[...new Set(hits)].slice(0, 6).join(" | ")}`);
}
// list player scripts
for (const s of pl.body.matchAll(/src="([^"]+\.js[^"]*)"/g)) console.log(`  script: ${s[1]}`);
// dump any URLs with sub/vtt/cc in them
for (const u of pl.body.matchAll(/https?:\/\/[^"'\s<>]+/g)) {
  if (/sub|vtt|srt|capt|cc/i.test(u[0])) console.log(`  url: ${u[0].slice(0, 140)}`);
}
