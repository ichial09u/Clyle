#!/usr/bin/env node
/** Does undici + proxy headers + Range work against the WCO CDN (sandbox)? */
import { execFile } from "node:child_process";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
function curlText(url, hdrs = []) {
  return new Promise((res) => execFile("curl", ["-sS", "--max-time", "20", "-A", UA, "--compressed", "-w", "\n__ST__%{http_code}", url, ...hdrs.flatMap((h) => ["-H", h])], { maxBuffer: 32 * 1024 * 1024 }, (e, out) => {
    const m = String(out).match(/__ST__(\d+)\s*$/);
    res({ status: m ? +m[1] : 0, body: String(out).replace(/__ST__\d+\s*$/, "") });
  }));
}
(async () => {
  const page = await curlText("https://www.wcostream.tv/south-park-season-13-episode-1-the-ring");
  const m = page.body.match(/embed\.wcostream\.com\/inc\/embed\/index\.php\?file=([^"&]+)&[^"]*?pid=(\d+)/);
  const v = "neptun/" + decodeURIComponent(m[1]).replace(/\.flv$/i, ".mp4");
  const link = await curlText("https://embed.wcostream.com/inc/embed/getvidlink.php?v=" + encodeURIComponent(v) + "&embed=neptun&fullhd=1", ["X-Requested-With: XMLHttpRequest", "Referer: https://embed.wcostream.com/inc/embed/video-js.php"]);
  const j = JSON.parse(link.body);
  const fin = await curlText(j.server + "/getvid?evid=" + encodeURIComponent(j.enc) + "&json", ["Referer: https://embed.wcostream.com/"]);
  let url = fin.body.trim().replace(/\\\//g, "/").replace(/"/g, "");
  try { const p = JSON.parse(url); if (typeof p === "string") url = p; } catch {}
  for (const [label, headers] of [
    ["plain+range", { Range: "bytes=5000000-5000099" }],
    ["UA+rf+range", { "User-Agent": UA, Referer: "https://www.wcostream.tv/", Accept: "*/*", Range: "bytes=5000000-5000099" }],
    ["UA+noRef+range", { "User-Agent": UA, Accept: "*/*", Range: "bytes=5000000-5000099" }],
  ]) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
      const buf = await r.arrayBuffer();
      console.log(label, "->", r.status, buf.byteLength + "B", "cr=" + (r.headers.get("content-range") || "-"), "ct=" + (r.headers.get("content-type") || "-"));
    } catch (e) {
      console.log(label, "ERR", String(e).slice(0, 60));
    }
  }
})();
