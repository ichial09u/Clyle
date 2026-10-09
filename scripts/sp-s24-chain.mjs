#!/usr/bin/env node
/** Raw WCO chain for S24E3 (Post COVID) — inspect getvidlink fields to see why the final host is empty. */
import { execFile } from "node:child_process";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const EMBED = "https://embed.wcostream.com";
const get = (url, headers = []) =>
  new Promise((resolve) => {
    execFile("curl", ["-sS", "--max-time", "20", "-A", UA, "--compressed", ...headers, url], { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => resolve(stdout ?? String(err)));
  });

const slug = process.argv[2] || "south-park-season-24-episode-3-post-covid";
const page = await get(`https://www.wcostream.tv/${slug}`);
const m = page.match(/embed\.wcostream\.com\/inc\/embed\/index\.php\?file=([^"&]+)&[^"]*?pid=(\d+)/);
if (!m) {
  console.log("no embed on page; head:", page.slice(0, 200).replace(/\n/g, " "));
  process.exit(0);
}
const file = decodeURIComponent(m[1]);
const v = `neptun/${file.replace(/\.flv$/i, ".mp4")}`;
console.log("pid:", m[2], "\nv:", v);
for (const fullhd of [true, false]) {
  const link = await get(`${EMBED}/inc/embed/getvidlink.php?v=${encodeURIComponent(v)}&embed=neptun${fullhd ? "&fullhd=1" : ""}`, ["-H", "X-Requested-With: XMLHttpRequest", "-H", `Referer: ${EMBED}/inc/embed/video-js.php`]);
  console.log(`fullhd=${fullhd}:`, link.slice(0, 600));
}
