#!/usr/bin/env node
/** last-10-min activity mix of the army log */
import { readFile } from "node:fs/promises";

const raw = await readFile("/home/z/my-project/scripts/all-shows-skip-army.log", "utf8").catch(() => "");
const cutoff = Date.now() - 10 * 60_000;
const counts = new Map();
const samples = [];
let total = 0;
for (const l of raw.split("\n")) {
  if (!l.trim()) continue;
  let j; try { j = JSON.parse(l); } catch { continue; }
  if (!j.at || new Date(j.at).getTime() < cutoff) continue;
  total++;
  const v = (j.verdict ?? "?").replace(/\d+/g, "#");
  counts.set(v, (counts.get(v) ?? 0) + 1);
  if ((j.verdict === "REPAIR-RETRY" || j.verdict === "REPAIR-STILL-BAD") && samples.length < 6) samples.push(`${j.key}: ${(j.detail ?? "").slice(0, 90)}`);
}
console.log("last 10 min:", total, "events");
for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
console.log("retry samples:\n  " + (samples.join("\n  ") || "(none)"));
