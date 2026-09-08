#!/usr/bin/env node
/**
 * Targeted re-verify of DUB walk RESOLVE-FAIL keys (dev-server outage
 * window + transient provider fails). Reads the dub verdict log, re-runs
 * the player click-chain once per key on lang=dub, tallies recoveries.
 * No repairs, no posts — measurement-only triage; uncovered survivors get
 * re-queued by the next DB-driven campaign naturally.
 */
import { readFile } from "node:fs/promises";

const BASE = "http://localhost:3000";
const LOG = "/home/z/my-project/scripts/all-shows-skip-army-dub.log";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const raw = await readFile(LOG, "utf8");
const latest = new Map();
for (const l of raw.split("\n")) {
  if (!l.trim()) continue;
  let j; try { j = JSON.parse(l); } catch { continue; }
  if (!j.key || !j.verdict) continue;
  latest.set(j.key, j.verdict);
}
const failKeys = [...latest.entries()].filter(([, v]) => v === "RESOLVE-FAIL").map(([k]) => k);
console.log(`[reverify] ${failKeys.length} dub RESOLVE-FAIL keys to re-check`);

async function verifyOne(key) {
  const slash = key.indexOf("/");
  const malId = key.slice(0, slash), ep = key.slice(slash + 1);
  try {
    const res = await fetch(`${BASE}/api/stream?malId=${malId}&ep=${ep}&lang=dub&server=1`, { signal: AbortSignal.timeout(50_000) });
    if (res.status === 404) return "NO-DUB";
    if (res.status !== 200) return "FAIL-" + res.status;
    const j = await res.json();
    if (!j.src) return "NO-SRC";
    if (!j.skip?.intro) return "NO-BUTTON";
    const { start, end } = j.skip.intro;
    if (!(end > start) || start > 420 || end - start > 180) return "BAD-SHAPE";
    return "PASS";
  } catch (e) {
    return "NET-" + String(e?.cause?.code ?? e?.message ?? "err").slice(0, 20);
  }
}

const LANES = 6;
const results = new Map();
let idx = 0;
async function lane(id) {
  for (;;) {
    const i = idx++;
    if (i >= failKeys.length) return;
    const key = failKeys[i];
    const v = await verifyOne(key);
    results.set(v, (results.get(v) ?? 0) + 1);
    if (i % 100 === 0) {
      console.log(`[reverify] ${i}/${failKeys.length} — ${[...results.entries()].map(([k, n]) => `${k}:${n}`).join(" ")}`);
    }
    await sleep(120);
  }
}
await Promise.all(Array.from({ length: LANES }, (_, i) => lane(i)));
console.log("[reverify] FINAL:", [...results.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join("  "));
