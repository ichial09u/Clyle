/**
 * Probe: does the WCO getvid MP4 for S13E1 support HTTP Range (206)?
 * The player reports "seeking forward resets me back" — a 200-full-body
 * (no Range) response would force Chrome to restart the resource on any
 * unbuffered seek, which reads exactly like that bug.
 */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SITE = "https://www.wcostream.tv";
const EMBED = "https://embed.wcostream.com";
const SLUG = process.argv[2] ?? "south-park-season-13-episode-1-the-ring";

import { execFile } from "node:child_process";

const curl = (url, headers = [], extra = []) =>
  new Promise((res) => {
    execFile("curl", ["-sS", "--compressed", "--max-time", "20", "-A", UA, ...extra, ...headers.flatMap((h) => ["-H", h]), url], { maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (e, out) => {
      res(e ? null : out);
    });
  });

(async () => {
  const page = await curl(`${SITE}/${SLUG}`);
  const m = page?.match(/embed\.wcostream\.com\/inc\/embed\/index\.php\?file=([^"&]+)&[^"]*?pid=(\d+)/);
  if (!m) return console.log("FAIL: no embed params", page?.slice(0, 200));
  const file = decodeURIComponent(m[1]);
  const v = `neptun/${file.replace(/\.flv$/i, ".mp4")}`;
  const link = await curl(`${EMBED}/inc/embed/getvidlink.php?v=${encodeURIComponent(v)}&embed=neptun&fullhd=1`, ["X-Requested-With: XMLHttpRequest", `Referer: ${EMBED}/inc/embed/video-js.php`]);
  let j;
  try { j = JSON.parse(link); } catch { return console.log("FAIL: getvidlink not JSON:", link?.slice(0, 200)); }
  const final = await curl(`${j.server}/getvid?evid=${encodeURIComponent(j.enc)}&json`, [`Referer: ${EMBED}/`]);
  let url = final.trim().replace(/^"|"$/g, "").replace(/\\\//g, "/");
  try { const p = JSON.parse(url); if (typeof p === "string") url = p; } catch {}
  console.log("MP4 URL:", url.slice(0, 110));

  // HEAD-ish: range probe at 5 MB
  const head = await curl(url, [], ["-r", "5000000-5000099", "-o", "/dev/null", "-w", "code=%{http_code} size=%{size_download}"]);
  console.log("RANGE PROBE:", head);
  const full = await curl(url, [], ["-o", "/dev/null", "-w", "code=%{http_code} size=%{size_download} accept=%{content_type}"]);
  console.log("FULL PROBE (truncated via --max-time): skip");
})().catch((e) => console.log("ERR", e.message));
