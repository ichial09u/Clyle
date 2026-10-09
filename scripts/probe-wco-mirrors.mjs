#!/usr/bin/env node
/** Probe WCO sister domains for the dead SP slugs (page + embed + getvid). */
import { execFile } from "node:child_process";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
function curl(url, headers = []) {
  return new Promise((resolve) => {
    const args = ["-sS", "--max-time", "18", "-A", UA, "--compressed", "-w", "\n__ST__%{http_code}", url, ...headers.flatMap((h) => ["-H", h])];
    execFile("curl", args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      const m = stdout.match(/__ST__(\d+)\s*$/);
      resolve({ status: m ? +m[1] : 0, body: stdout.replace(/__ST__\d+\s*$/, "") });
    });
  });
}

const SLUGS = [
  "south-park-season-23-episode-10-christmas-snow",
  "south-park-season-24-episode-3-post-covid",
  "south-park-post-covid",
  "south-park-bigger-longer-uncut",
  "south-park-streaming-wars",
  "south-park-streaming-wars-part-2",
];
const DOMAINS = ["https://www.wcofun.net", "https://www.wcoforever.net", "https://www.wcostream.org", "https://www.wco.tv", "https://www.wcostream.net", "https://www.wcofld.net", "https://www.wcoventory.net", "https://www.wcostream.tv"];

for (const d of DOMAINS) {
  const alive = await curl(`${d}/anime/south-park`);
  console.log(`\n### ${d} series-page=${alive.status} len=${alive.body.length}`);
  if (alive.status !== 200) continue;
  for (const slug of SLUGS) {
    const page = await curl(`${d}/${slug}`);
    if (page.status !== 200) { console.log(`  ${slug}: PAGE ${page.status}`); continue; }
    const m = page.body.match(/embed\.wcostream\.[a-z]+\/inc\/embed\/index\.php\?file=([^"&]+)&[^"]*?pid=(\d+)/);
    if (!m) { console.log(`  ${slug}: page 200 but NO EMBED (gated?)`); continue; }
    const file = decodeURIComponent(m[1]);
    const v = `neptun/${file.replace(/\.flv$/i, ".mp4")}`;
    const link = await curl(`${d.replace("//www.", "//")}/inc/embed/getvidlink.php?v=${encodeURIComponent(v)}&embed=neptun&fullhd=1`, ["X-Requested-With: XMLHttpRequest", `Referer: ${d}/inc/embed/video-js.php`]);
    let verdict = `vidlink=${link.status}`;
    try {
      const j = JSON.parse(link.body);
      verdict += ` server=${j.server || "-"}`;
      if (j.server && j.enc) {
        const fin = await curl(`${j.server}/getvid?evid=${encodeURIComponent(j.enc)}&json`, [`Referer: ${d}/`]);
        const url = fin.body.replace(/\\\//g, "/").replace(/"/g, "").trim();
        const emptyHost = /^https?:\/\/\./.test(url);
        verdict += ` final=${fin.status}${emptyHost ? " EMPTY-HOST" : ""}`;
        if (!emptyHost && /^https?:\/\//.test(url)) {
          const probe = await curl(url, ["Range: bytes=0-1023"]);
          verdict += ` bytes=${probe.status}`;
        }
      }
    } catch { verdict += " (bad json)"; }
    console.log(`  ${slug}: ${verdict}`);
  }
}
