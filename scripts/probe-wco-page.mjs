#!/usr/bin/env node
/** Dump all embed iframe candidates on a WCO episode page + resolve final video. */
import { execFile } from "node:child_process";

const SITE = "https://www.wcostream.tv";
const EMBED = "https://embed.wcostream.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const REF = `${EMBED}/inc/embed/video-js.php`;

function curl(url, headers = []) {
  return new Promise((resolve) => {
    execFile("curl", ["-sS", "--max-time", "15", "-A", UA, "--compressed", "-w", "\n__STATUS__%{http_code}", url, ...headers.flatMap((h) => ["-H", h])], { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      const m = stdout.match(/__STATUS__(\d+)\s*$/);
      resolve({ status: m ? +m[1] : 0, body: stdout.replace(/__STATUS__\d+\s*$/, "") });
    });
  });
}

const slug = process.argv[2];
const page = await curl(`${SITE}/${slug}`);
console.log(`page: ${page.status}, len=${page.body.length}`);
const tags = [...page.body.matchAll(/<iframe[^>]*src="([^"]*embed[^"]*)"[^>]*>/gi)];
console.log(`iframe tags: ${tags.length}`);
for (const t of tags) console.log(`  ${t[1].slice(0, 140)}`);
const m = page.body.match(/embed\.wcostream\.com\/inc\/embed\/index\.php\?file=([^"&]+)&[^"]*?pid=(\d+)/);
if (!m) { console.log("no main embed match"); process.exit(0); }
const file = decodeURIComponent(m[1]);
console.log(`file=${file}`);
console.log(`pid=${m[2]}`);
const v = `neptun/${file.replace(/\.flv$/i, ".mp4")}`;
const link = await curl(`${EMBED}/inc/embed/getvidlink.php?v=${encodeURIComponent(v)}&embed=neptun&fullhd=1`, ["X-Requested-With: XMLHttpRequest", `Referer: ${REF}`]);
console.log(`vidlink: ${link.status} ${link.body.slice(0, 300)}`);
try {
  const j = JSON.parse(link.body);
  const fin = await curl(`${j.server}/getvid?evid=${encodeURIComponent(j.enc)}&json`, [`Referer: ${EMBED}/`]);
  console.log(`final(enc): ${fin.status} ${fin.body.slice(0, 200)}`);
  const fu = fin.body.replace(/\\\//g, "/").replace(/"/g, "").trim();
  if (/^https?:\/\//.test(fu)) {
    const head = await curl(fu, ["Range: bytes=0-1023"]);
    console.log(`bytes(enc): ${head.status} ct=${(head.body.match(/content-type:[^\r\n]*/i) || [""])[0]} len=${head.body.length}`);
  }
} catch (e) { console.log(`resolve fail: ${e.message}`); }
