#!/usr/bin/env node
/** timeline + detail analysis of RESOLVE-FAIL / NO-OP in the all-shows army log */
import { readFile } from "node:fs/promises";

const raw = await readFile("/home/z/my-project/scripts/all-shows-skip-army.log", "utf8").catch(() => "");
const lines = raw.trim() ? raw.trim().split("\n") : [];

// 1) resolve-fail bucket by detail reason
const reasons = new Map();
const failTimes = [];
for (const l of lines) {
  let j; try { j = JSON.parse(l); } catch { continue; }
  if (j.verdict === "RESOLVE-FAIL") {
    const r = (j.detail ?? "").replace(/\d+/g, "#").slice(0, 60);
    reasons.set(r, (reasons.get(r) ?? 0) + 1);
    failTimes.push(j.at);
  }
}
console.log("resolve-fail reasons:");
for (const [k, v] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`  ${v}\t${k}`);

// 2) resolve-fail timeline: per 10-min bucket
const buckets = new Map();
for (const t of failTimes) {
  const d = new Date(t);
  d.setMinutes(Math.floor(d.getMinutes() / 10) * 10, 0, 0);
  const k = d.toISOString().slice(11, 16);
  buckets.set(k, (buckets.get(k) ?? 0) + 1);
}
console.log("\nresolve-fail per 10min:");
for (const [k, v] of [...buckets.entries()].sort()) console.log(`  ${k}  ${"█".repeat(Math.min(60, Math.round(v / 20)))} ${v}`);

// 3) live probe: are resolves failing RIGHT NOW? sample 3 fresh fails
const now = Date.now();
const fresh = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((j) => j && j.verdict === "RESOLVE-FAIL" && now - new Date(j.at).getTime() < 10 * 60_000)
  .slice(-5);
console.log("\nfresh fails (last 10min):", fresh.length);
for (const f of fresh.slice(0, 3)) console.log(" ", f.key, f.detail);
