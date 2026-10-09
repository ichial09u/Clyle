#!/usr/bin/env node
/**
 * Live verification of the WCO multi-quality chain (quality task):
 * episode page -> embed params -> getvidlink -> resolve enc/hd/fhd finals
 * in parallel -> report the REAL ladder for a few representative episodes.
 */
import { execFile } from "node:child_process";

const SITE = "https://www.wcostream.tv";
const EMBED = "https://embed.wcostream.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function curlGet(url, headers = {}, timeoutMs = 15000) {
  const args = ["-sS", "--max-time", String(Math.ceil(timeoutMs / 1000)), "-A", UA, "--compressed", "-w", "\n__STATUS__%{http_code}", url];
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  return new Promise((resolve) => {
    execFile("curl", args, { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs + 5000 }, (err, stdout) => {
      const m = stdout.match(/__STATUS__(\d+)\s*$/);
      if (!m) return resolve(null);
      resolve({ status: parseInt(m[1], 10), body: stdout.replace(/__STATUS__\d+\s*$/, "") });
    });
  });
}

async function ladderOf(slug) {
  const page = await curlGet(`${SITE}/${slug}`);
  if (!page || page.status !== 200) return { slug, error: `page ${page?.status}` };
  const m = page.body.match(/embed\.wcostream\.com\/inc\/embed\/index\.php\?file=([^"&]+)&[^"]*?pid=(\d+)/);
  if (!m) return { slug, error: "no embed" };
  const v = `neptun/${decodeURIComponent(m[1]).replace(/\.flv$/i, ".mp4")}`;
  const linkRaw = await curlGet(`${EMBED}/inc/embed/getvidlink.php?v=${encodeURIComponent(v)}&embed=neptun&fullhd=1`, {
    Accept: "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    Referer: `${EMBED}/inc/embed/video-js.php`,
  });
  if (!linkRaw || linkRaw.status !== 200) return { slug, error: `vidlink ${linkRaw?.status}` };
  let link;
  try { link = JSON.parse(linkRaw.body); } catch { return { slug, error: "vidlink parse" }; }
  const final = async (evid) => {
    if (!evid || !link.server) return null;
    const out = await curlGet(`${link.server}/getvid?evid=${encodeURIComponent(evid)}&json`, { Referer: `${EMBED}/` }, 15000);
    if (!out || out.status !== 200) return null;
    let url = out.body.trim().replace(/\\\//g, "/");
    try { const p = JSON.parse(url); if (typeof p === "string") url = p; } catch { /* plain */ }
    return /^https?:\/\/[^.]/.test(url) ? url : null;
  };
  const [fhd, hd, enc] = await Promise.all([final(link.fhd), final(link.hd), final(link.enc)]);
  const ladder = [];
  if (fhd) ladder.push(1080);
  if (hd) ladder.push(720);
  if (enc) ladder.push(360);
  return { slug, ladder, tokens: { fhd: !!link.fhd, hd: !!link.hd, enc: !!link.enc } };
}

const CASES = [
  "south-park-season-13-episode-1-the-ring",
  "south-park-season-1-episode-1-cartman-gets-an-anal-probe",
  "south-park-season-28-episode-5",
  "south-park-post-covid-covid-returns-special",
];

for (const c of CASES) {
  const r = await ladderOf(c);
  console.log(JSON.stringify(r));
}
