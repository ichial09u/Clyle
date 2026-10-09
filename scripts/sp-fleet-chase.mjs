#!/usr/bin/env node
/** Chase the 3 failing fleet bots: S23E10 (no resolve) + S24E3/E4 (byte probe http=0). */
import { execFile } from "node:child_process";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BASE = "https://temporary-spry-granite-1f0h7ae.vercel.app";
const get = (url, extra = []) =>
  new Promise((resolve) => {
    execFile("curl", ["-sS", "--max-time", "25", "-A", UA, "--compressed", "-w", "\n__STATUS__%{http_code}", ...extra, url], { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      const m = stdout.match(/__STATUS__(\d+)\s*$/);
      resolve(m ? { status: parseInt(m[1], 10), body: stdout.replace(/__STATUS__\d+\s*$/, "") } : { status: 0, body: String(err) });
    });
  });

// 1) what does production think these are?
for (const q of ["malId=999923&ep=10", "malId=999924&ep=3", "malId=999924&ep=4"]) {
  const r = await get(`${BASE}/api/stream?${q}&lang=dub`);
  console.log(`stream ${q}: http=${r.status} body=${r.body.slice(0, 160)}`);
}

// 2) the baked slugs' WCO pages alive?
for (const slug of ["south-park-season-23-episode-10-christmas-snow", "south-park-season-24-episode-3", "south-park-season-24-episode-4"]) {
  const r = await get(`https://www.wcostream.tv/${slug}`);
  const embed = (r.body.match(/embed\.wcostream\.com\/inc\/embed\/index\.php\?[^"]+/) || [])[0];
  console.log(`page ${slug}: http=${r.status} embed=${embed ? "YES" : "NO"} finalTitle=${(r.body.match(/<title>([^<]*)/) || [])[1] ?? "?"}`);
}

// 3) what episodes does WCO's season-23 / season-24 list carry now?
for (const season of [23, 24]) {
  const r = await get(`https://www.wcostream.tv/anime/south-park`);
  const eps = [...r.body.matchAll(new RegExp(`href="/(south-park-season-${season}-episode-[^"]+)"`, "g"))].map((m) => m[1]);
  console.log(`season ${season} listing: ${eps.length} eps: ${eps.slice(0, 12).join(", ")}`);
}

// 4) S24E3/E4: byte-probe the resolved src with a longer timeout
const r = await get(`${BASE}/api/stream?malId=999924&ep=3&lang=dub`);
try {
  const src = JSON.parse(r.body).src;
  console.log(`S24E3 src host: ${new URL(src).host}`);
  const t0 = Date.now();
  const p = await get(src, ["-r", "0-1023", "--max-time", "40"]);
  console.log(`S24E3 bytes: http=${p.status} ct=${p.body.slice(0, 0)} len=${p.body.length} took=${Date.now() - t0}ms`);
} catch (e) {
  console.log("S24E3 probe fail:", e.message);
}
