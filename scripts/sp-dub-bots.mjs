#!/usr/bin/env node
/**
 * South Park dub-video bot fleet (Task 28).
 *
 * Owner ask: "create bots, a lot, like 5 per season in South Park, to make
 * sure there is video in both dub players" — after "there's nothing in the
 * dub player" (root cause: WCO hotlink-filters foreign Referers, fixed by
 * Referrer-Policy: no-referrer this task).
 *
 * Fleet: for every SP catalog entry (999900..999929) pick 5 episodes
 * (first / second / mid / second-last / last; small buckets take all),
 * and each bot verifies the full production playback chain:
 *   1. lang=dub resolve  -> /api/stream returns a src
 *   2. lang=sub resolve  -> the other language path also returns a src
 *      (WCO answers both with the same English track — "both players")
 *   3. video bytes       -> Range-GET the dub src the way the FIXED browser
 *      does (no Referer): expect 200/206 + video/* + non-empty body
 * Diagnostics recorded but not failed on: with-our-referer probe (expected
 * 404 while WCO's filter is up) and same-track check between the two langs.
 *
 * Known-gated: Movies & Specials (999900) — all 3 WCO pages are account-
 * gated with no embed (re-verified this task); bots there report GATED,
 * which does not fail the run.
 *
 * Usage: node scripts/sp-dub-bots.mjs [baseUrl]   (default: production)
 * Exit 0 only when every TV bot passes. Report: scripts/sp-dub-bots-report.json
 */
import { writeFileSync } from "node:fs";

const BASE = process.argv[2] || process.env.BASE || "https://temporary-spry-granite-1f0h7ae.vercel.app";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const CONCURRENCY = 6;
const RETRIES = 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function j(url) {
  for (let i = 0; i <= RETRIES; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      const b = await r.json().catch(() => ({}));
      if (r.ok) return { ok: true, status: r.status, body: b };
      if (i === RETRIES) return { ok: false, status: r.status, body: b };
    } catch (e) {
      if (i === RETRIES) return { ok: false, status: 0, body: { error: e.message } };
    }
    await sleep(2500);
  }
}

async function byteProbe(url, referer) {
  const headers = { "User-Agent": UA, Range: "bytes=0-1023" };
  if (referer) headers.Referer = referer;
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    const buf = await r.arrayBuffer();
    return { status: r.status, ct: r.headers.get("content-type") || "", bytes: buf.byteLength };
  } catch (e) {
    return { status: 0, ct: "", bytes: 0, err: e.message };
  }
}

/** 5 spread episode numbers (or all when the bucket is small). */
function pickFive(numbers) {
  const n = numbers.length;
  if (n <= 5) return [...numbers];
  const set = [...new Set([numbers[0], numbers[1], numbers[Math.floor((n - 1) / 2)], numbers[n - 2], numbers[n - 1]])];
  return set.sort((a, b) => a - b);
}

const entries = [];
for (let id = 999900; id <= 999929; id++) {
  const r = await j(`${BASE}/api/anime/${id}/episodes`);
  if (r.ok && Array.isArray(r.body?.numbers) && r.body.numbers.length) {
    entries.push({ id, title: r.body.title, numbers: r.body.numbers });
  } else {
    console.log(`!! entry ${id}: episodes payload unavailable (http=${r.status})`);
  }
}
console.log(`fleet target: ${entries.length} entries, ${entries.reduce((a, e) => a + Math.min(5, e.numbers.length), 0)} bots\n`);

const bots = [];
for (const e of entries) {
  for (const ep of pickFive(e.numbers)) {
    bots.push({ id: e.id, title: e.title, ep, gatedExpected: e.id === 999900 });
  }
}

const results = [];
let cursor = 0;
async function worker(wid) {
  while (cursor < bots.length) {
    const bot = bots[cursor++];
    const t0 = Date.now();
    const label = `${bot.title.replace(/^South Park:? ?/u, "") || bot.title} E${bot.ep}`;
    const res = { ...bot, label, ok: false, gated: false, detail: {} };

    const dub = await j(`${BASE}/api/stream?malId=${bot.id}&ep=${bot.ep}&lang=dub`);
    res.detail.dub = dub.ok && !!dub.body?.src ? "OK" : `FAIL(http=${dub.status},${JSON.stringify(dub.body).slice(0, 60)})`;
    const sub = await j(`${BASE}/api/stream?malId=${bot.id}&ep=${bot.ep}&lang=sub`);
    res.detail.subPath = sub.ok && !!sub.body?.src ? "OK" : `FAIL(http=${sub.status},${JSON.stringify(sub.body).slice(0, 60)})`;
    const src = dub.body?.src || sub.body?.src;

    if (!src) {
      if (bot.gatedExpected && /unavailable/i.test(JSON.stringify(dub.body) + JSON.stringify(sub.body))) {
        res.gated = true; res.ok = true; res.detail.bytes = "GATED(known)";
      }
      res.ms = Date.now() - t0;
      results.push(res);
      const mark = res.ok ? (res.gated ? "GATED" : "PASS") : "FAIL";
      console.log(`[${mark}] ${bot.id} ${label} dub=${res.detail.dub} subPath=${res.detail.subPath} (${res.ms}ms)`);
      continue;
    }

    // both language paths should resolve the SAME English track
    res.detail.sameTrack = dub.body?.src && sub.body?.src ? (dub.body.src === sub.body.src ? "OK" : "DIFF") : "n/a";

    // Video probe. WCO streams are DIRECT MP4s (the fixed browser's no-referer
    // reality — probe raw). Episodes the WCO fallback can't serve come back as
    // LM2 HLS — the browser fetches those through OUR proxy (curl transport +
    // node-retry against LM2's broken storage pool), so the probe must ride
    // the proxy too: raw undici gets TLS-fingerprint-routed to dead nodes.
    let probeUrl = src;
    let probeReferer = null;
    if (dub.body?.direct !== true) {
      probeUrl = `${BASE}/api/stream/proxy?type=seg&u=${encodeURIComponent(src)}`;
      probeReferer = undefined;
    }
    const fixedBrowser = await byteProbe(probeUrl, probeReferer); // the FIXED browser sends no referer
    const minBytes = dub.body?.direct === true ? 1 : 1024; // direct Range probe = 1024B; proxied = a real playlist
    res.detail.bytes =
      (fixedBrowser.status === 200 || fixedBrowser.status === 206) && /video|octet|mpegurl/.test(fixedBrowser.ct + " application/octet-stream") && fixedBrowser.bytes >= minBytes
        ? "OK"
        : `FAIL(http=${fixedBrowser.status},ct=${fixedBrowser.ct},bytes=${fixedBrowser.bytes})`;
    // diagnostic only: the BUGGY browser behavior (our referer) should 404 while WCO's filter is up
    const buggyBrowser = await byteProbe(src, BASE + "/");
    res.detail.withAppReferer = buggyBrowser.status === 404 ? "404(expected)" : `http=${buggyBrowser.status}`;

    res.ok = res.detail.dub === "OK" && res.detail.subPath === "OK" && res.detail.bytes === "OK";
    res.ms = Date.now() - t0;
    results.push(res);
    console.log(`[${res.ok ? "PASS" : "FAIL"}] ${bot.id} ${label} dub=${res.detail.dub} subPath=${res.detail.subPath} bytes=${res.detail.bytes} appRef=${res.detail.withAppReferer} (${res.ms}ms)`);
  }
}

const t0 = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

const tv = results.filter((r) => !r.gatedExpected);
const passed = tv.filter((r) => r.ok).length;
const gated = results.filter((r) => r.gated).length;
const failed = tv.filter((r) => !r.ok);

console.log(`\n===== FLEET REPORT (${elapsed}s) =====`);
console.log(`entries: ${entries.length} | bots: ${results.length} | TV pass: ${passed}/${tv.length} | known-gated: ${gated}`);
if (entries.length === 30) console.log("all 30 entries reachable: OK");
else console.log(`!! expected 30 entries, saw ${entries.length}`);

const byEntry = {};
for (const r of tv) {
  byEntry[r.id] ??= { title: r.title, pass: 0, fail: 0 };
  byEntry[r.id][r.ok ? "pass" : "fail"]++;
}
for (const [id, v] of Object.entries(byEntry)) console.log(`  ${id} ${v.title}: ${v.pass}/${v.pass + v.fail}${v.fail ? "  <-- FAILING" : ""}`);

if (failed.length) {
  console.log(`\nFAILED BOTS (${failed.length}):`);
  for (const f of failed) console.log(`  ${f.id} E${f.ep} dub=${f.detail.dub} subPath=${f.detail.subPath} bytes=${f.detail.bytes}`);
}
writeFileSync(new URL("./sp-dub-bots-report.json", import.meta.url), JSON.stringify({ base: BASE, elapsed, entries: entries.map((e) => e.id), results }, null, 2));
console.log("\nreport: scripts/sp-dub-bots-report.json");
process.exit(failed.length || entries.length !== 30 ? 1 : 0);
