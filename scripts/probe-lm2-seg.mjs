#!/usr/bin/env node
/** Probe: what do LM2 segment fetches need? (headers / retry pattern) */
import { execFile } from "node:child_process";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SITE = "https://www.lookmovie2.to";
const PLAY = SITE + "/shows/play/1689878855-south-park-1997";

function curl(url, hdrs = [], bin = false) {
  return new Promise((res) => {
    const a = ["-sS", "--max-time", "25", "-A", UA, "-w", "\n__ST__%{http_code}", url];
    for (const h of hdrs) a.push("-H", h);
    execFile("curl", a, { maxBuffer: 64 * 1024 * 1024, encoding: bin ? "buffer" : "utf8" }, (e, out) => {
      if (bin) {
        const i = out.lastIndexOf("__ST__");
        res({ status: i >= 0 ? parseInt(out.subarray(i + 6, i + 12).toString(), 10) : 0, body: i >= 0 ? out.subarray(0, i) : out });
      } else {
        const m = String(out).match(/__ST__(\d+)\s*$/);
        res({ status: m ? +m[1] : 0, body: String(out).replace(/__ST__\d+\s*$/, "") });
      }
    });
  });
}

(async () => {
  const page = await curl(PLAY);
  const hash = page.body.match(/hash:\s*'([^']+)'/)?.[1];
  const expires = page.body.match(/expires:\s*(\d+)/)?.[1];
  const r = await curl(`${SITE}/api/v1/security/episode-access?id_episode=59011&hash=${hash}&expires=${expires}`, ["Referer: " + PLAY, "X-Requested-With: XMLHttpRequest"]);
  const j = JSON.parse(r.body);
  console.log("stream keys:", Object.keys(j.streams ?? {}));
  for (let att = 0; att < 8; att++) {
    const pu = j.streams["480p"] || j.streams["480"] || Object.values(j.streams).find(Boolean);
    const pl = await curl(pu);
    if (pl.status === 200 && String(pl.body).trimStart().startsWith("#EXTM")) {
      const segs = String(pl.body).split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
      console.log("playlist OK attempt", att + 1, "| seg count:", segs.length, "| first:", segs[0]?.slice(0, 90));
      const abs = new URL(segs[0], pu).toString();
      for (const hdrs of [[], ["Referer: " + SITE + "/"], ["Referer: " + new URL(pu).origin + "/"]]) {
        const sg = await curl(abs, hdrs, true);
        const head = sg.body && sg.body.length > 30 ? sg.body.subarray(0, 20).toString("latin1").replace(/[^\x20-\x7e]/g, ".") : "";
        console.log(`seg fetch ${JSON.stringify(hdrs)} -> ${sg.status} ${sg.body?.length || 0}B head=${head}`);
      }
      break;
    }
    await new Promise((r2) => setTimeout(r2, 700));
  }
})();
