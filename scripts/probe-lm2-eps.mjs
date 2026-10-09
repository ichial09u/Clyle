#!/usr/bin/env node
/** Test lookmovie2 episode-access for key SP items: dead eps + movie + sample. */
import { execFile } from "node:child_process";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BASE = "https://www.lookmovie2.to";
function curl(url, headers = []) {
  return new Promise((resolve) => {
    const args = ["-sS", "--max-time", "20", "-A", UA, "--compressed", "-w", "\n__ST__%{http_code}", url, ...headers.flatMap((h) => ["-H", h])];
    execFile("curl", args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      const m = stdout.match(/__ST__(\d+)\s*$/);
      resolve({ status: m ? +m[1] : 0, body: stdout.replace(/__ST__\d+\s*$/, "") });
    });
  });
}

// fresh hash/expires from the play page
const page = await curl(`${BASE}/shows/play/1689878855-south-park-1997`);
const hash = page.body.match(/hash:\s*'([^']+)'/)?.[1];
const expires = page.body.match(/expires:\s*(\d+)/)?.[1];
console.log(`show hash=${hash} expires=${expires} page=${page.status}`);

async function epAccess(id, label) {
  const url = `${BASE}/api/v1/security/episode-access?id_episode=${id}&hash=${hash}&expires=${expires}`;
  const r = await curl(url, ["Referer: https://www.lookmovie2.to/shows/play/1689878855-south-park-1997", "X-Requested-With: XMLHttpRequest"]);
  if (r.status !== 200) { console.log(`${label}: ACCESS ${r.status} ${r.body.slice(0, 120)}`); return null; }
  let j;
  try { j = JSON.parse(r.body); } catch { console.log(`${label}: bad json`); return null; }
  if (!j.success) { console.log(`${label}: success=false ${JSON.stringify(j).slice(0, 120)}`); return null; }
  const streamKinds = Object.entries(j.streams || {}).map(([k, v]) => `${k}=${v ? "OK" : "null"}`).join(" ");
  const subs = j.subtitles || [];
  const eng = subs.filter((s) => /english/i.test(s.language));
  console.log(`${label}: streams[${streamKinds}] subs=${subs.length} english=${eng.length}`);
  // probe the first live m3u8
  for (const [q, u] of Object.entries(j.streams || {})) {
    if (!u) continue;
    const m3 = await curl(u);
    const seg = (m3.body.split("\n").find((l) => l && !l.startsWith("#")) || "").trim();
    let segVerdict = "no-seg";
    if (m3.status === 200 && seg) {
      const segUrl = new URL(seg, u).href;
      const s2 = await curl(segUrl, ["Range: bytes=0-4095"]);
      segVerdict = `seg=${s2.status} bytes=${s2.body.length}`;
    }
    console.log(`   ${q}: m3u8=${m3.status} ${segVerdict}`);
    break; // first live quality only
  }
  return j;
}

await epAccess(59266, "S2E7 (sample TV)");
await epAccess(71957, "S23E10 Christmas Snow (DEAD on WCO)");
await epAccess(156660, "S24E0 (Post COVID? DEAD on WCO)");
await epAccess(137488, "S24E1 Pandemic Special");
await epAccess(385169, "S0E45 Bigger Longer & Uncut (GATED on WCO)");
