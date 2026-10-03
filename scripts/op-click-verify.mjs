#!/usr/bin/env node
/**
 * OP click-verify — UI-level Skip Intro verification on the real site.
 *
 * The measurement fleet proves the DATA (per-episode OP intervals); this bot
 * proves the EXPERIENCE: it opens the real player on localhost, plays the
 * episode muted, seeks just before the measured opening, watches for the
 * Skip Intro button to appear (the user's criterion: "the skip intro should
 * appear when opening arrives"), CLICKS it, and checks the landing point
 * (the user's criterion: the opening's last ~3 seconds still play).
 *
 * Results: scripts/op-click-verify-results.jsonl
 * Usage:
 *   node scripts/op-click-verify.mjs                 # sample of measured eps
 *   node scripts/op-click-verify.mjs --eps 1,100,588 # explicit list
 *   node scripts/op-click-verify.mjs --sample 14     # bigger sample
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, appendFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const run = promisify(execFile);
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const EPS_ARG = opt("eps", "");
const SAMPLE = parseInt(opt("sample", "10"), 10) || 10;
const RESULTS = new URL("./op-click-verify-results.jsonl", import.meta.url).pathname;
const BASE = opt("base", "http://localhost:3000");

const AB = "agent-browser";
const abTimeout = 45_000;

async function ab(cmd, args2, timeout = abTimeout) {
  try {
    const { stdout } = await run(AB, [cmd, ...args2], { timeout });
    return stdout.trim();
  } catch (e) {
    return `ERR: ${String(e.message).slice(0, 120)}`;
  }
}

/** eval with JSON return value */
async function ev(js, timeout) {
  const out = await ab("eval", [js], timeout);
  if (out.startsWith("ERR:") || out.startsWith("Evaluation error")) return { err: out };
  try {
    return { val: JSON.parse(out.replace(/^"(.*)"$/s, "$1").replace(/\\"/g, '"').replace(/\\n/g, "\n")) };
  } catch {
    return { val: out };
  }
}

async function loadMeasured() {
  const raw = await readFile(new URL("./op-sub-fleet-results.jsonl", import.meta.url).pathname, "utf8").catch(() => "");
  const byEp = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.measured && r.verdict !== "error") byEp.set(r.ep, r);
    } catch { /* skip */ }
  }
  return byEp;
}

async function pickSample() {
  const byEp = await loadMeasured();
  if (EPS_ARG) {
    const eps = EPS_ARG.split(",").map((s) => parseInt(s, 10)).filter(Boolean);
    return eps.map((ep) => byEp.get(ep)).filter(Boolean);
  }
  const measured = [...byEp.values()];
  if (!measured.length) return [];
  measured.sort((a, b) => a.ep - b.ep);
  const step = Math.max(1, Math.floor(measured.length / SAMPLE));
  const out = [];
  for (let i = 0; i < measured.length && out.length < SAMPLE; i += step) out.push(measured[i]);
  return out;
}

/** drive the SPA from home to the player for one episode */
async function openEpisode(ep) {
  await ab("open", [BASE]);
  await sleep(6_000);
  // search (retry — the input can take a beat to mount after cold boot)
  let typed = "no-input";
  for (let i = 0; i < 5 && !String(typed).includes("ok"); i++) {
    await ev("(() => { const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') || x.textContent || '').trim().toLowerCase() === 'search'); if (b) b.click(); return b ? 'ok' : 'no-search-btn'; })()");
    await sleep(1_200);
    typed = await ev("(() => { const i = document.querySelector('input'); if (!i) return 'no-input'; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(i, 'One Piece'); i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()");
    if (!String(typed.val).includes("ok")) await sleep(1_500);
  }
  if (!String(typed.val).includes("ok")) return `search-input failed: ${typed.err || typed.val}`;
  await sleep(3_500);
  // exact ONE PIECE card
  const clicked = await ev("(() => { const node = [...document.querySelectorAll('*')].find(el => el.children.length === 0 && /^ONE PIECE$/i.test((el.textContent || '').trim())); if (!node) return 'no-card'; const wrap = node.closest('div.grid > div'); const btn = wrap && wrap.querySelector('button'); if (btn) { btn.click(); return 'ok'; } return 'no-btn'; })()");
  if (!String(clicked.val).includes("ok")) return `card click failed: ${clicked.val}`;
  await sleep(4_000);
  // episodes list (details "Episodes" button) — the details CTA "Watch" also
  // routes through the episode picker; prefer the explicit Episodes button
  const eps = await ev("(() => { const b = [...document.querySelectorAll('button')].find(x => /^episodes$/i.test((x.textContent || '').trim())); if (b) { b.click(); return 'ok'; } const w = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === 'Watch'); if (w) { w.click(); return 'watch'; } return 'none'; })()");
  if (!String(eps.val).includes("ok") && !String(eps.val).includes("watch")) return `episodes click failed: ${eps.val}`;
  await sleep(3_000);
  // the episode number button (the episodes grid can take a beat to load)
  let epClick = "retrying";
  for (let i = 0; i < 5 && !String(epClick.val).includes("ok"); i++) {
    await sleep(2_500);
    epClick = await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === '${ep}'); if (b) { b.click(); return 'ok'; } return 'no-ep-btn'; })()`);
  }
  if (!String(epClick.val).includes("ok")) return `ep${ep} button failed: ${epClick.val}`;
  await sleep(2_000);
  // server sheet
  const srv = await ev("(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === 'SUB Server #1'); if (b) { b.click(); return 'ok'; } return 'no-server-btn'; })()");
  if (!String(srv.val).includes("ok")) return `server sheet failed: ${srv.val}`;
  // wait for the video element + data
  for (let i = 0; i < 24; i++) {
    await sleep(2_500);
    const v = await ev("(() => { const v = document.querySelector('video'); return v ? 'ready=' + v.readyState : 'none'; })()");
    if (String(v.val).includes("ready=") && !String(v.val).includes("ready=0")) return "ok";
  }
  return "video never became ready";
}

/** the actual click test on the open player */
async function clickTest(row) {
  const armed = await ev(`(() => {
    const v = document.querySelector('video');
    if (!v) return 'no-video';
    v.muted = true;
    const target = ${JSON.stringify(row)};
    window.__cv = { appearAt: null, landedAt: null, clicked: false, preClick: null, err: null };
    const seekTo = Math.max(0, target.measured.start - 4);
    const poll = setInterval(() => {
      const vv = document.querySelector('video');
      if (!vv) { window.__cv.err = 'video gone'; clearInterval(poll); return; }
      const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('Skip Intro'));
      if (btn && window.__cv.appearAt == null && vv.currentTime >= seekTo) window.__cv.appearAt = vv.currentTime;
      if (btn && window.__cv.appearAt != null && !window.__cv.clicked && vv.currentTime >= window.__cv.appearAt + 0.8) {
        window.__cv.clicked = true;
        window.__cv.preClick = vv.currentTime;
        btn.click();
      }
      // landing = the seek JUMP after the click (timeupdate granularity makes
      // one-shot +450ms reads flaky — watch for the >10 s leap instead)
      if (window.__cv.clicked && window.__cv.landedAt == null && window.__cv.preClick != null
          && vv.currentTime > window.__cv.preClick + 10) {
        window.__cv.landedAt = vv.currentTime;
        clearInterval(poll);
      }
      if (vv.currentTime > target.measured.end + 25) clearInterval(poll);
    }, 200);
    v.currentTime = seekTo;
    const p = v.play();
    if (p && p.catch) p.catch(() => {});
    return 'armed';
  })()`);
  if (!String(armed.val).includes("armed")) return `arm failed: ${armed.err || armed.val}`;
  // wait for the click + landing (song tail up to ~2.5 min)
  for (let i = 0; i < 40; i++) {
    await sleep(3_000);
    const st = await ev("(() => window.__cv ? JSON.stringify(window.__cv) : 'gone')()");
    try {
      const s = JSON.parse(st.val);
      if (s.landedAt != null) return s;
      if (s === "gone") return { error: "state gone" };
    } catch { /* keep waiting */ }
  }
  const st = await ev("(() => window.__cv ? JSON.stringify(window.__cv) : 'gone')()");
  return { error: `timeout: ${st.val}` };
}

async function main() {
  const sample = await pickSample();
  if (!sample.length) {
    console.log("no measured episodes to verify yet — run the campaign first");
    return;
  }
  console.log(`click-verify: ${sample.length} episodes (${sample.map((s) => s.ep).join(",")})`);
  await ab("close", []).catch(() => {});

  let pass = 0, fail = 0;
  for (const row of sample) {
    const opened = await openEpisode(row.ep);
    if (opened !== "ok") {
      console.log(`ep${row.ep}: OPEN FAILED (${opened})`);
      await appendFile(RESULTS, JSON.stringify({ at: new Date().toISOString(), ep: row.ep, error: opened }) + "\n").catch(() => {});
      fail++;
      continue;
    }
    const res = await clickTest(row);
    if (res.landedAt != null) {
      const appearDelta = res.appearAt - row.measured.start;
      const landTarget = row.measured.end - 3;
      const landDelta = res.landedAt - landTarget;
      const appearOk = appearDelta >= -2 && appearDelta <= 3;
      const landOk = landDelta >= -1.5 && landDelta <= 2;
      const ok = appearOk && landOk;
      if (ok) pass++; else fail++;
      console.log(`ep${row.ep}: ${ok ? "PASS" : "FAIL"} — button at ${res.appearAt.toFixed(1)}s (OP starts ${row.measured.start}, Δ${appearDelta >= 0 ? "+" : ""}${appearDelta.toFixed(1)}s), landed ${res.landedAt.toFixed(1)}s (target ${landTarget.toFixed(1)}, Δ${landDelta >= 0 ? "+" : ""}${landDelta.toFixed(1)}s)`);
      await appendFile(RESULTS, JSON.stringify({ at: new Date().toISOString(), ep: row.ep, measured: row.measured, appearAt: res.appearAt, landedAt: res.landedAt, appearDelta, landDelta, ok }) + "\n").catch(() => {});
    } else {
      fail++;
      console.log(`ep${row.ep}: CLICK TEST FAILED (${res.error || JSON.stringify(res)})`);
      await appendFile(RESULTS, JSON.stringify({ at: new Date().toISOString(), ep: row.ep, error: res.error || "no landing", state: res }) + "\n").catch(() => {});
    }
  }
  console.log(`click-verify done: ${pass} pass / ${fail} fail`);
  await ab("close", []).catch(() => {});
}

main().catch((e) => { console.error(`fatal: ${e.message}`); process.exit(1); });
