#!/usr/bin/env node
/** Probe WCO getvidlink for the `sub` (caption) field on South Park episodes. */
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

const slugs = process.argv.slice(2);
for (const slug of slugs) {
  const page = await curl(`${SITE}/${slug}`);
  if (page.status !== 200) { console.log(`${slug}: PAGE ${page.status}`); continue; }
  const m = page.body.match(/embed\.wcostream\.com\/inc\/embed\/index\.php\?file=([^"&]+)&[^"]*?pid=(\d+)/);
  if (!m) { console.log(`${slug}: NO EMBED`); continue; }
  const v = `neptun/${decodeURIComponent(m[1]).replace(/\.flv$/i, ".mp4")}`;
  for (const fullhd of [true, false]) {
    const link = await curl(`${EMBED}/inc/embed/getvidlink.php?v=${encodeURIComponent(v)}&embed=neptun${fullhd ? "&fullhd=1" : ""}`, ["X-Requested-With: XMLHttpRequest", `Referer: ${REF}`]);
    if (link.status !== 200) { console.log(`${slug} fullhd=${fullhd}: VIDLINK ${link.status} ${link.body.slice(0, 80)}`); continue; }
    try {
      const j = JSON.parse(link.body);
      console.log(`${slug} fullhd=${fullhd}: enc=${(j.enc || "").slice(0, 18)}... hd=${!!j.hd} fhd=${!!j.fhd} server=${j.server} SUB=${j.sub ? j.sub.slice(0, 30) : "null"} extra=${j.sub_info ? JSON.stringify(j.sub_info).slice(0, 120) : "-"} keys=${Object.keys(j).join(",")}`);
    } catch { console.log(`${slug} fullhd=${fullhd}: BAD JSON ${link.body.slice(0, 100)}`); }
    break;
  }
}
