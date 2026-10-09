#!/usr/bin/env node
/** Find the working repair host for the empty-CDN final URL (S24E3 Post COVID). */
import { execFile } from "node:child_process";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const EMBED = "https://embed.wcostream.com";
const get = (url, headers = [], max = 20) =>
  new Promise((resolve) => {
    execFile("curl", ["-sS", "--max-time", String(max), "-A", UA, "--compressed", "-w", "\n__STATUS__%{http_code}", ...headers, url], { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      const m = (stdout || "").match(/__STATUS__(\d+)\s*$/);
      resolve(m ? { status: parseInt(m[1], 10), body: (stdout || "").replace(/__STATUS__\d+\s*$/, "") } : { status: 0, body: String(err).slice(0, 80) });
    });
  });

const slug = "south-park-season-24-episode-3-post-covid";
const page = await get(`https://www.wcostream.tv/${slug}`);
const m = page.body.match(/embed\.wcostream\.com\/inc\/embed\/index\.php\?file=([^"&]+)&[^"]*?pid=(\d+)/);
const file = decodeURIComponent(m[1]);
const v = `neptun/${file.replace(/\.flv$/i, ".mp4")}`;
const linkRaw = await get(`${EMBED}/inc/embed/getvidlink.php?v=${encodeURIComponent(v)}&embed=neptun&fullhd=1`, ["-H", "X-Requested-With: XMLHttpRequest", "-H", `Referer: ${EMBED}/inc/embed/video-js.php`]);
const link = JSON.parse(linkRaw.body);
console.log("server:", link.server, "| cdn:", link.cdn);

// step 1: the final JSON answer (empty host)
const finalRaw = await get(`${link.server}/getvid?evid=${encodeURIComponent(link.enc)}&json`, ["-H", `Referer: ${EMBED}/`]);
const finalUrl = JSON.parse(finalRaw.body); // getvid answers a JSON string URL
console.log("raw getvid status:", finalRaw.status);
console.log("final answer:", finalUrl);
const evidReturned = finalUrl.split("evid=")[1];

// step 2: candidates — requesting host + common uNN prefixes, both evids
const hosts = ["https://neptun.wcostream.com", "https://u20.wcostream.com", "https://u16.wcostream.com", "https://u32.wcostream.com", "https://u8.wcostream.com", "https://u24.wcostream.com"];
for (const h of hosts) {
  for (const [label, evid] of [["returned", evidReturned], ["requested", link.enc]]) {
    if (!evid) continue;
    const r = await get(`${h}/getvid?evid=${evid}`, ["-H", `Referer: ${EMBED}/`, "-r", "0-255"], 15);
    const mp4 = r.status === 206 || r.status === 200;
    console.log(`${h} evid=${label}: http=${r.status} ${mp4 ? "VIDEO-OK" : r.body.slice(0, 40).replace(/\n/g, " ")}`);
  }
}

// step 3: follow neptun's 302 — where does it send the player?
const REDIR = ["-sS", "--max-time", "25", "-A", UA, "-r", "0-255", "-o", "/dev/null", "-D", "-", "-L", "-H", `Referer: ${EMBED}/`];
const followed = await new Promise((resolve) => {
  execFile("curl", [...REDIR, `https://neptun.wcostream.com/getvid?evid=${evidReturned}`], { maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(stdout ?? String(err)));
});
console.log("=== 302 chain headers ===");
console.log(followed.split("\n").filter((l) => /^HTTP|^location|^content-type|^content-length/i.test(l)).join("\n"));

// step 4: the empty prefix might mean the APEX domain — try wcostream.com / www
for (const h of ["https://wcostream.com", "https://www.wcostream.com"]) {
  const r = await get(`${h}/getvid?evid=${evidReturned}`, ["-H", `Referer: ${EMBED}/`, "-r", "0-255"], 15);
  const mp4 = r.status === 206 || r.status === 200;
  console.log(`${h} (apex repair): http=${r.status} ct-len=${r.body.length} ${mp4 ? "VIDEO-OK" : r.body.slice(0, 60).replace(/\n/g, " ")}`);
}

// step 5: where do the apex 301s go? Follow ONE hop without -L.
for (const h of ["https://wcostream.com", "https://www.wcostream.com"]) {
  const r = await new Promise((resolve) => {
    execFile("curl", ["-sS", "--max-time", "15", "-A", UA, "-r", "0-255", "-o", "/dev/null", "-D", "-", "-H", `Referer: ${EMBED}/`, `${h}/getvid?evid=${evidReturned}`], { maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(stdout ?? String(err)));
  });
  const loc = (r.match(/^location:\s*(\S+)/im) || [])[1];
  console.log(`${h} -> ${loc ?? "(no location)"}`);
  if (loc) {
    const r2 = await get(loc, ["-H", `Referer: ${EMBED}/`, "-r", "0-255"], 15);
    console.log(`   followed: http=${r2.status} ${r2.status === 206 || r2.status === 200 ? "VIDEO-OK" : r2.body.slice(0, 50).replace(/\n/g, " ")}`);
  }
}
