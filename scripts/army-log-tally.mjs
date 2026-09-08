#!/usr/bin/env node
/** quick tally of all-shows army log verdicts */
import { readFile } from "node:fs/promises";

const LOG = "/home/z/my-project/scripts/all-shows-skip-army.log";
const raw = await readFile(LOG, "utf8").catch(() => "");
const lines = raw.trim() ? raw.trim().split("\n") : [];
const byVerdict = new Map();
const failsByShow = new Map();
const sources = new Map();
for (const l of lines) {
  let j;
  try { j = JSON.parse(l); } catch { continue; }
  const v = j.verdict ?? "?";
  byVerdict.set(v, (byVerdict.get(v) ?? 0) + 1);
  if (j.source) sources.set(j.source, (sources.get(j.source) ?? 0) + 1);
  if (v !== "PASS" && j.title) failsByShow.set(j.title, (failsByShow.get(j.title) ?? 0) + 1);
}
console.log("verdicts:", [...byVerdict.entries()].map(([k, v]) => `${k}:${v}`).join("  "));
console.log("sources:", [...sources.entries()].map(([k, v]) => `${k}:${v}`).join("  "));
console.log("fail shows:", [...failsByShow.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}(${v})`).join("  "));
// sample fail details
const samples = [];
for (const l of lines) {
  let j;
  try { j = JSON.parse(l); } catch { continue; }
  if (j.verdict && j.verdict !== "PASS" && samples.length < 8) samples.push(`${j.key} ${j.verdict}: ${(j.detail ?? "").slice(0, 80)}`);
}
console.log("samples:\n  " + samples.join("\n  "));
