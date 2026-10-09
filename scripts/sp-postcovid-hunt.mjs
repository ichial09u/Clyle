#!/usr/bin/env node
/** Time-boxed: does WCO carry Post COVID 1&2 under any other (working) page? */
import { execFile } from "node:child_process";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const EMBED = "https://embed.wcostream.com";
const get = (url, h = []) =>
  new Promise((resolve) => {
    execFile("curl", ["-sS", "--max-time", "20", "-A", UA, "--compressed", "-w", "\n__STATUS__%{http_code}", ...h, url], { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      const m = (stdout || "").match(/__STATUS__(\d+)\s*$/);
      resolve(m ? { status: parseInt(m[1], 10), body: (stdout || "").replace(/__STATUS__\d+\s*$/, "") } : { status: 0, body: "" });
    });
  });

// search WCO for post-covid pages
const q = await get("https://www.wcostream.tv/search?q=post+covid");
const pages = [...new Set([...q.body.matchAll(/href="(\/[a-z0-9-]*post-covid[a-z0-9-]*)"/gi)].map((m) => m[1]))];
console.log("search hit pages:", pages.join(", ") || "(none)");

// test each page's embed + the final answer's host health
for (const p of pages.slice(0, 6)) {
  const page = await get(`https://www.wcostream.tv${p}`);
  const m = page.body.match(/embed\.wcostream\.com\/inc\/embed\/index\.php\?file=([^"&]+)&[^"]*?pid=(\d+)/);
  if (!m) {
    console.log(`${p}: http=${page.status} embed=NO`);
    continue;
  }
  const file = decodeURIComponent(m[1]);
  const v = `neptun/${file.replace(/\.flv$/i, ".mp4")}`;
  const linkRaw = await get(`${EMBED}/inc/embed/getvidlink.php?v=${encodeURIComponent(v)}&embed=neptun&fullhd=1`, ["-H", "X-Requested-With: XMLHttpRequest", "-H", `Referer: ${EMBED}/inc/embed/video-js.php`]);
  let link = {};
  try { link = JSON.parse(linkRaw.body); } catch { /* 403 etc */ }
  let finalHost = "(no answer)";
  if (link.server && link.enc) {
    const fin = await get(`${link.server}/getvid?evid=${encodeURIComponent(link.enc)}&json`, ["-H", `Referer: ${EMBED}/`]);
    try {
      const u = JSON.parse(fin.body);
      finalHost = new URL(u).host || "EMPTY-HOST";
    } catch { finalHost = `unparsed(${fin.body.slice(0, 40)})`; }
  }
  console.log(`${p}: http=${page.status} file=${file.split("/").pop().slice(0, 50)} server=${link.server ?? "?"} finalHost=${finalHost}`);
}
