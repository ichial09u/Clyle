import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const DIR = join(process.cwd(), "db", "anivexa-cache");
const file = (key: string) => join(DIR, createHash("sha1").update(key).digest("hex").slice(0, 24) + ".json");
const want = ["eps:113415", "watch:animegg:113415:dub:1", "watch:allmanga:113415:dub:1", "watch:reanime:113415:dub:1", "watch:hianime:113415:dub:1", "watch:anineko:113415:dub:1", "summary:40748"];
for (const k of want) {
  const p = file(k);
  if (!existsSync(p)) { console.log(`${k}: NO DISK FILE`); continue; }
  try {
    const e = JSON.parse(readFileSync(p, "utf8"));
    const age = Math.round((Date.now() - e.at) / 60000);
    const data = e.data;
    let desc = typeof data === "string" ? data : Array.isArray(data) ? `array[${data.length}]` : data ? JSON.stringify(data).slice(0, 220) : String(data);
    console.log(`${k}: ttl=${Math.round(e.ttl/60000)}m age=${age}m data=${desc}`);
  } catch (err) { console.log(`${k}: unreadable ${err}`); }
}
// also: which cached keys mention 113415?
const files = readdirSync(DIR);
let hits = 0;
for (const f of files) {
  try {
    const e = JSON.parse(readFileSync(join(DIR, f), "utf8"));
    const s = JSON.stringify(e.data ?? "");
    if (s.includes("113415")) { hits++; if (hits <= 6) console.log(`hit file ${f} age=${Math.round((Date.now()-e.at)/60000)}m -> ${s.slice(0,140)}`); }
  } catch {}
}
console.log(`files mentioning 113415: ${hits} / ${files.length}`);
