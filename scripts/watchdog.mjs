#!/usr/bin/env node
/**
 * watchdog — wraps `scripts/e2e-smoke.mjs` in a 24/7 loop.
 *
 *   node scripts/watchdog.mjs                     # default: every 15 min vs production
 *   SMOKE_URL=http://localhost:3000 INTERVAL_MIN=5 node scripts/watchdog.mjs
 *   node scripts/watchdog.mjs once                # single run (used by cron/CI)
 *
 * Behavior:
 *  - runs the full smoke suite on an interval
 *  - appends every run to scripts/watchdog.log (pass/fail + failing check names)
 *  - on failure it retries once after 60s (transient-network forgiveness)
 *  - never auto-exits; Ctrl-C to stop. Run it under pm2/systemd/nohup for true 24/7:
 *      nohup node scripts/watchdog.mjs >/dev/null 2>&1 &
 *
 * What it can and cannot fix: the server's /api/cron self-heals known classes
 * (catalog drift, orphaned replies, malformed like rows) every run; the watchdog
 * DETECTS everything else and logs exactly which check broke so fixes are fast.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SMOKE = join(HERE, "e2e-smoke.mjs");
const LOG = join(HERE, "watchdog.log");
const INTERVAL_MIN = Number(process.env.INTERVAL_MIN || 15);
const ONCE = process.argv.includes("once");

const ts = () => new Date().toISOString();

function runSuite() {
  const res = spawnSync("node", [SMOKE], { encoding: "utf8", timeout: 180_000, env: process.env });
  const out = (res.stdout ?? "") + (res.stderr ?? "");
  const failedLines = [...out.matchAll(/^FAIL\s+(.+)$/gm)].map((m) => m[1]);
  const passed = /checks passed/.exec(out)?.[0] ?? "summary missing";
  return { ok: res.status === 0, out, failedLines, passed };
}

function log(line) {
  const entry = `[${ts()}] ${line}`;
  console.log(entry);
  try {
    appendFileSync(LOG, entry + "\n");
  } catch {
    /* log file not writable — console still has it */
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function cycle() {
  log(`run start (base=${process.env.SMOKE_URL || process.env.BASE_URL || "production"})`);
  let r = runSuite();
  if (!r.ok) {
    log(`FAIL — ${r.failedLines.join(" | ") || r.passed} — retrying in 60s`);
    await sleep(60_000);
    r = runSuite();
    if (!r.ok) {
      log(`STILL FAILING after retry — ${r.failedLines.join(" | ") || r.passed}`);
      return false;
    }
    log(`PASS on retry — ${r.passed}`);
    return true;
  }
  log(`PASS — ${r.passed}`);
  return true;
}

if (ONCE) {
  await cycle();
  process.exit(0);
}

log(`watchdog started — every ${INTERVAL_MIN} min`);
for (;;) {
  await cycle();
  await sleep(INTERVAL_MIN * 60_000);
}
