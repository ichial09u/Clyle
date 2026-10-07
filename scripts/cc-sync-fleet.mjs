#!/usr/bin/env node
/**
 * CC-SYNC FLEET — bots that measure how far a provider's caption track lags
 * (or leads) the DUB audio, per episode. Owner report: Soul Eater's dub CC
 * is delayed. This fleet measures the drift exactly, episode by episode,
 * and stores a verdict the player applies automatically.
 *
 * How one bot measures one episode (NO ASR — pure DSP, the IntroScout way):
 *   1. resolve the DUB stream (zoko payload decode, kiwi fallback) — the
 *      exact chain the player's DUB button runs
 *   2. download the episode's English CC (WebVTT) + the HLS segment timeline
 *   3. cut three 60s analysis windows across the dialogue-dense body of the
 *      episode (OP/ED zones avoided)
 *   4. in each window build two timelines at 0.25s resolution:
 *        A = caption activity (a cue is showing)          <- the VTT clock
 *        B = speech activity (ffmpeg silencedetect)       <- the audio clock
 *   5. cross-correlate A against B for lags in [-8s, +8s]; captions late by
 *      d means caption-on at t pairs with speech-on at t-d, so the lag with
 *      the maximum overlap IS the drift. Sharp, quota-free, +-0.25s.
 *   6. median across windows + prominence x agreement -> CaptionSync(malId, ep, lang)
 *
 * The player (WatchView) GETs /api/captions and shifts every VTTCue earlier
 * by offsetMs so the text lands with the voice.
 *
 * Usage:
 *   node scripts/cc-sync-fleet.mjs --malId 3588 --eps 1-51 --workers 4
 *   node scripts/cc-sync-fleet.mjs --top 10 --eps-per 3               (catalog audit)
 *   flags: --lang dub --windows 3 --force --quiet
 */
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// the harness injects a global DATABASE_URL pointing at <root>/db/custom.db
// (which doesn't exist — the real db lives in src/db/) — always win here
process.env.DATABASE_URL = "file:/home/z/my-project/src/db/custom.db";
// scripts/ has no node_modules of its own — resolve the app's deps from src/
const requireFromSrc = createRequire("/home/z/my-project/src/package.json");
const { PrismaClient } = requireFromSrc("@prisma/client");
const db = new PrismaClient();
const execFile = promisify(_execFile);

const ORIGIN = "https://zokoanime.video";
const KEY = "otaku-embed-v1";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const H = { "User-Agent": UA, Origin: ORIGIN, Referer: `${ORIGIN}/` };

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORT_JSONL = join(__dirname, "cc-sync-report.jsonl");
const PROGRESS_JSON = join(__dirname, "cc-sync-progress.json");

/* ---------------- args ---------------- */
const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true) : def;
};
const MAL_ID = parseInt(flag("malId"), 10) || null;
const TOP_N = parseInt(flag("top"), 10) || null;
const EPS_PER = parseInt(flag("eps-per"), 10) || 3;
const EPS = flag("eps", null); // "1-51" | "25" | null = all dub
const WORKERS = Math.max(1, parseInt(flag("workers"), 10) || 4);
const LANG = flag("lang") === "sub" ? "sub" : "dub";
const WINDOWS_WANT = Math.max(1, parseInt(flag("windows"), 10) || 4);
const FORCE = flag("force") === true;
const QUIET = flag("quiet") === true;
const DL_CONC = 4; // parallel segment downloads per bot

const log = (...m) => { if (!QUIET) console.log(...m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- concurrency primitives ---------------- */
function pool(n) {
  const waiters = [];
  let active = 0;
  return {
    async take() {
      if (active < n) { active++; return; }
      await new Promise((r) => waiters.push(r));
      active++;
    },
    release() {
      active--;
      const w = waiters.shift();
      if (w) w();
    },
  };
}
const dlSlot = pool(DL_CONC);

/** fetch with one retry on transient aborts — several bots bursting the same
 *  CDN at once trips per-IP throttling; a spaced retry rides it out */
async function fetchRetry(url, opts, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, opts);
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(2_500 + Math.random() * 2_000);
    }
  }
}

/* ---------------- zoko payload / playlists ---------------- */
function xor(str) { let o = ""; for (let i = 0; i < str.length; i++) o += String.fromCharCode(str.charCodeAt(i) ^ KEY.charCodeAt(i % KEY.length)); return o; }
function decodeBlob(blob) { return JSON.parse(decodeURIComponent(escape(xor(atob(blob))))); }

async function resolveDub(malId, ep, lang) {
  for (const server of ["zoko", "kiwi"]) {
    try {
      const url = server === "kiwi"
        ? `${ORIGIN}/stream/mal/${malId}/${ep}/${lang}?server=kiwi`
        : `${ORIGIN}/stream/mal/${malId}/${ep}/${lang}`;
      const res = await fetchRetry(url, { headers: { ...H, Accept: "text/html" }, signal: AbortSignal.timeout(25_000) });
      if (res.status === 404 || res.status === 410) continue;
      const html = await res.text();
      const m = html.match(/window\.__P="([^"]+)"/);
      if (!m) continue;
      const json = decodeBlob(m[1]);
      if (json?.src) return { server, src: json.src, subtitles: Array.isArray(json.subtitles) ? json.subtitles : [] };
    } catch { /* try next server */ }
  }
  return null;
}

async function playlist(masterUrl) {
  const mtext = await (await fetchRetry(masterUrl, { headers: H, signal: AbortSignal.timeout(20_000) })).text();
  const variants = mtext.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  if (!variants.length) throw new Error("empty master");
  const vurl = new URL(variants[Math.min(1, variants.length - 1)].trim(), masterUrl).href;
  const vtext = await (await fetchRetry(vurl, { headers: H, signal: AbortSignal.timeout(20_000) })).text();
  const lines = vtext.split("\n");
  const segs = [];
  let t = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#EXTINF:([\d.]+)/);
    if (m) {
      const dur = parseFloat(m[1]);
      const url = (lines[i + 1] ?? "").trim();
      if (url && !url.startsWith("#")) { segs.push({ url: new URL(url, vurl).href, start: t, dur }); t += dur; }
    }
  }
  return { segs, total: t };
}

async function fetchText(url, headers = H) {
  const res = await fetchRetry(url, { headers, signal: AbortSignal.timeout(25_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/* ---------------- VTT parsing ---------------- */
function vttSeconds(s) {
  const m = s.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
  if (!m) return NaN;
  const ms = m[4].length === 1 ? m[4] * 100 : m[4].length === 2 ? m[4] * 10 : +m[4];
  return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + ms / 1000;
}
function parseVtt(text) {
  const cues = [];
  const body = text.replace(/^X-TIMESTAMP-MAP=.*$/gm, "").replace(/^WEBVTT[^\n]*$/gm, "");
  for (const block of body.split(/\n\s*\n/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const tl = lines.find((l) => l.includes("-->"));
    if (!tl) continue;
    const [a, b] = tl.split("-->");
    const start = vttSeconds(a), end = vttSeconds(b);
    if (!isFinite(start) || !isFinite(end)) continue;
    const txt = lines.filter((l) => l !== tl && !/^\d+$/.test(l)).join(" ")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .trim();
    if (txt) cues.push({ start, end, text: txt });
  }
  return cues;
}

/* ---------------- audio loudness envelope (no ASR, no silence threshold) ---------------- */
const WORK = mkdtempSync(join(tmpdir(), 'ccsync-'));
const ffmpeg = (args, timeout = 120_000) => execFile('ffmpeg', ['-hide_banner', '-nostats', ...args], { timeout, maxBuffer: 32 * 1024 * 1024 });

async function downloadSegments(segs) {
  const bufs = await Promise.all(segs.map(async (s) => {
    await dlSlot.take();
    try {
      const res = await fetchRetry(s.url, { headers: H, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`seg ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } finally { dlSlot.release(); }
  }));
  return Buffer.concat(bufs);
}

/**
 * Per-bin loudness envelope of the episode in [w0, w0+W], voice-band filtered
 * (250-3400Hz keeps dub dialogue, drops bass drums + cymbal shimmer) and
 * dumped as 8kHz mono PCM; RMS per 0.25s bin in Node. The BGM floor is
 * ~constant, so the envelope's SWELLS are the dialogue.
 */
async function loudnessEnvelope(segs, w0, W, tag) {
  const covering = segs.filter((s) => s.start + s.dur > w0 && s.start < w0 + W);
  if (!covering.length) throw new Error('no segments for window');
  const ts = join(WORK, `${tag}.ts`);
  writeFileSync(ts, await downloadSegments(covering));
  // binary PCM out -> execFile must NOT utf8-decode stdout
  const { stdout } = await execFile("ffmpeg", [
    "-hide_banner", "-nostats",
    "-i", ts, "-ss", Math.max(0, w0 - covering[0].start).toFixed(2), "-t", W.toFixed(2),
    "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "8000",
    "-af", "highpass=f=250,lowpass=f=3400", "-f", "s16le", "pipe:1",
  ], { timeout: 150_000, maxBuffer: 32 * 1024 * 1024, encoding: "buffer" });
  const pcm = stdout;
  const n = Math.ceil(W / BIN);
  const env = new Float32Array(n);
  const per = 8000 * BIN; // samples per bin
  for (let k = 0; k < n; k++) {
    let sum = 0, cnt = 0;
    const s0 = k * per, s1 = Math.min(pcm.length / 2, (k + 1) * per);
    for (let i = s0; i < s1; i++) {
      const v = pcm.readInt16LE(i * 2) / 32768;
      sum += v * v; cnt++;
    }
    env[k] = cnt ? Math.sqrt(sum / cnt) : 0;
  }
  // 2-bin moving average — dialogue swells span ~1s, smoothing drops bin noise
  const sm = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const a = env[Math.max(0, k - 1)], b = env[k], c = env[Math.min(n - 1, k + 1)];
    sm[k] = (a + b + c) / 3;
  }
  return sm;
}

/* ---------------- correlation ---------------- */
const BIN = 0.25;        // seconds per envelope bin (-> +-0.25s accuracy)
const LAG_MIN = -8, LAG_MAX = 8; // caption drift range we can detect

function captionSeries(intervals, W) {
  const n = Math.ceil(W / BIN);
  const s = new Uint8Array(n);
  for (const [a, b] of intervals) {
    for (let k = Math.max(0, Math.floor(a / BIN)); k < Math.min(n, Math.ceil(b / BIN)); k++) s[k] = 1;
  }
  return s;
}

/**
 * Pearson cross-correlation between the caption series and the loudness
 * envelope at each lag — bounded to [-1, 1], no unstable normalization.
 * Captions late by d pair caption-on bins with speech d seconds earlier, so
 * the correlation peaks at the true drift. Positive d = captions late.
 */
function correlateEnv(cap, env) {
  const n = Math.min(cap.length, env.length);
  let onBins = 0, offBins = 0, capSum = 0, envSum = 0;
  for (let k = 0; k < n; k++) {
    capSum += cap[k]; envSum += env[k];
    if (cap[k]) onBins++; else offBins++;
  }
  if (onBins < 60 || offBins < 24) return { d: null, reason: "no caption gaps", onBins, offBins };
  const cBar = capSum / n, eBar = envSum / n;
  let capVar = 0, envVar = 0;
  for (let k = 0; k < n; k++) {
    const dc = cap[k] - cBar, de = env[k] - eBar;
    capVar += dc * dc; envVar += de * de;
  }
  if (envVar < 1e-9) return { d: null, reason: "flat audio envelope", onBins, offBins };
  const denom = Math.sqrt(capVar * envVar) || 1e-9;
  const scores = [];
  let best = { d: null, score: -Infinity };
  for (let lag = LAG_MIN / BIN; lag <= LAG_MAX / BIN; lag++) {
    let cov = 0;
    for (let k = 0; k < n; k++) {
      const j = k - lag;
      if (j < 0 || j >= n) continue;
      cov += (cap[k] - cBar) * (env[j] - eBar);
    }
    const r = cov / denom;
    scores.push(r);
    if (r > best.score) best = { d: lag * BIN, score: r };
  }
  const sorted = [...scores].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  return { d: best.d, score: +best.score.toFixed(3), prominence: +(best.score - med).toFixed(3), onBins, offBins };
}
/* ---------------- per-episode measurement ---------------- */
const WIN_LEN = 90; // seconds per analysis window — more cue events = sharper peak

function pickWindows(cues, total) {
  const zoneA = Math.max(90, total * 0.22), zoneB = total * 0.75;
  const picks = [];
  for (let i = 0; i < WINDOWS_WANT; i++) {
    const center = zoneA + ((i + 0.5) / WINDOWS_WANT) * (zoneB - zoneA);
    const w0 = Math.max(0, center - WIN_LEN / 2);
    // require the VTT to be active >=15% of the window (dialogue-dense)
    const active = cues.filter((c) => c.start < w0 + WIN_LEN && c.end > w0).length;
    const density = cues.reduce((acc, c) => acc + Math.max(0, Math.min(c.end, w0 + WIN_LEN) - Math.max(c.start, w0)), 0) / WIN_LEN;
    if (active >= 6 && density >= 0.15) picks.push({ w0, density });
  }
  return picks;
}

async function measureWindow(segs, cues, w0, tag) {
  const env = await loudnessEnvelope(segs, w0, WIN_LEN, tag);
  const capIntervals = cues
    .filter((c) => c.start < w0 + WIN_LEN && c.end > w0)
    .map((c) => [Math.max(0, c.start - w0), Math.min(WIN_LEN, c.end - w0)]);
  const A = captionSeries(capIntervals, WIN_LEN);
  const r = correlateEnv(A, env);
  if (r.d == null) return { w0, d: null, reason: r.reason ?? "no-lag-peak", onBins: r.onBins, offBins: r.offBins };
  return { w0, d: r.d, score: r.score, prominence: r.prominence, onBins: r.onBins, offBins: r.offBins };
}

const medianOf = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

async function measureEpisode(malId, ep, title) {
  const tag = `m${malId}e${ep}`;
  const resolved = await resolveDub(malId, ep, LANG);
  if (!resolved) return { ep, status: "no-dub-stream" };
  const track = (() => {
    const subs = resolved.subtitles;
    if (!subs?.length) return null;
    const norm = (s) => (s ?? "").trim().toLowerCase();
    return subs.find((t) => norm(t.label) === "english")
      ?? subs.find((t) => /\benglish\b/.test(norm(t.label)))
      ?? subs.find((t) => t.default === true)
      ?? subs[0];
  })();
  if (!track?.src) return { ep, status: "no-cc", server: resolved.server };
  const vtt = await fetchText(track.src);
  const cues = parseVtt(vtt);
  if (!cues.length) return { ep, status: "no-cc-cues", server: resolved.server };
  // the provider often ships the SUB timing under the DUB label — note it:
  // a measured drift against dub audio is then structural, not a retime slip
  let ccIsSubTiming = null;
  try {
    const sub = await resolveDub(malId, ep, "sub");
    const subTrack = sub?.subtitles?.find((t) => (t.label ?? "").toLowerCase().includes("english")) ?? sub?.subtitles?.[0];
    if (subTrack?.src) {
      const subCues = parseVtt(await fetchText(subTrack.src));
      if (subCues.length) {
        const n = Math.min(30, cues.length, subCues.length);
        let same = 0;
        for (let i = 0; i < n; i++) if (Math.abs(cues[i].start - subCues[i].start) < 0.01) same++;
        ccIsSubTiming = same >= n - 2;
      }
    }
  } catch { /* annotation only */ }
  const { segs, total } = await playlist(resolved.src);
  if (!segs.length) return { ep, status: "empty-playlist", server: resolved.server };
  const windows = pickWindows(cues, total);
  if (!windows.length) return { ep, status: "no-dialogue-windows", server: resolved.server };
  const results = [];
  for (let i = 0; i < windows.length; i++) {
    try {
      results.push(await measureWindow(segs, cues, windows[i].w0, `${tag}-w${i}`));
    } catch (e) {
      log(`  ep${ep} window${i}: ${String(e.message).slice(0, 90)}`);
    }
  }
  const good = results.filter((r) => r.d != null && r.d >= LAG_MIN && r.d <= LAG_MAX);
  const attempted = results.length;
  let offsetMs = 0, confidence = 0, spreadMs = 0;
  if (good.length) {
    const ds = good.map((r) => r.d);
    const med = medianOf(ds);
    const spread = Math.max(...ds) - Math.min(...ds);
    offsetMs = Math.round((med * 1000) / 100) * 100;
    spreadMs = Math.round(spread * 1000);
    const bestProm = Math.max(...good.map((r) => r.prominence ?? 0));
    const promFactor = bestProm >= 0.1 ? 1 : bestProm >= 0.06 ? 0.85 : bestProm >= 0.04 ? 0.7 : 0.5;
    // MAD-style agreement: windows voting with the median (outliers rejected)
    // beat a raw max-min spread — dub pacing scatters, one bad music lock
    // shouldn't sink a 3-window consensus
    const agreement = ds.filter((d) => Math.abs(d - med) <= 1.25).length / ds.length;
    const agreeFactor = agreement >= 0.75 ? 1 : agreement >= 0.5 ? 0.6 : 0.3;
    const countFactor = good.length >= 4 ? 1 : good.length === 3 ? 0.9 : good.length === 2 ? 0.7 : 0.45;
    confidence = Math.min(0.95, promFactor * agreeFactor * countFactor);
  }
  return {
    ep, status: "ok", server: resolved.server, offsetMs, confidence: +confidence.toFixed(2),
    samples: good.length, attempted, spreadMs,
    detail: JSON.stringify({
      windows: results.map((r) => ({ w0: +r.w0.toFixed(0), d: r.d == null ? null : +r.d.toFixed(2), score: r.score, prom: r.prominence, on: r.onBins, off: r.offBins, reason: r.reason })),
      ccIsSubTiming,
      track: (track.label || "").slice(0, 40),
      providerHost: new URL(resolved.src).hostname,
    }).slice(0, 1200),
  };
}

/* ---------------- DB upsert + progress ---------------- */
async function persist(malId, title, r) {
  if (r.status !== "ok") {
    appendFileSync(REPORT_JSONL, JSON.stringify({ at: new Date().toISOString(), malId, title, ...r, offsetMs: null }) + "\n");
    return;
  }
  await db.captionSync.upsert({
    where: { malId_ep_lang: { malId, ep: r.ep, lang: LANG } },
    create: {
      malId, ep: r.ep, lang: LANG, server: r.server || "", offsetMs: r.offsetMs,
      confidence: r.confidence, samples: r.samples, attempted: r.attempted,
      spreadMs: r.spreadMs, detail: r.detail, checkedAt: new Date(),
    },
    update: {
      server: r.server || "", offsetMs: r.offsetMs, confidence: r.confidence,
      samples: r.samples, attempted: r.attempted, spreadMs: r.spreadMs,
      detail: r.detail, checkedAt: new Date(),
    },
  });
  appendFileSync(REPORT_JSONL, JSON.stringify({ at: new Date().toISOString(), malId, title, ...r }) + "\n");
}

const progress = { startedAt: new Date().toISOString(), done: 0, total: 0, results: [] };
function saveProgress() {
  try { writeFileSync(PROGRESS_JSON, JSON.stringify(progress)); } catch { /* best effort */ }
}

/* ---------------- work list ---------------- */
function epsRange(spec) {
  const out = [];
  for (const part of String(spec).split(",")) {
    const m = part.match(/^(\d+)(-(\d+))?$/);
    if (!m) continue;
    const a = parseInt(m[1], 10), b = m[3] ? parseInt(m[3], 10) : a;
    for (let i = a; i <= b; i++) out.push(i);
  }
  return [...new Set(out)];
}

async function buildWork() {
  if (MAL_ID) {
    const anime = await db.anime.findUnique({ where: { malId: MAL_ID }, select: { title: true, totalEpisodes: true } });
    if (!anime) throw new Error(`malId ${MAL_ID} not in catalog`);
    const eps = EPS ? epsRange(EPS) : Array.from({ length: Math.max(1, anime.totalEpisodes) }, (_, i) => i + 1);
    return [{ malId: MAL_ID, title: anime.title, eps }];
  }
  if (TOP_N) {
    const animes = await db.anime.findMany({
      where: { hasDub: true, inCatalog: true },
      orderBy: { popularity: "desc" },
      take: TOP_N,
      select: { malId: true, title: true, totalEpisodes: true },
    });
    return animes.map((a) => {
      const n = Math.max(1, a.totalEpisodes);
      const spots = [...new Set(Array.from({ length: Math.min(EPS_PER, n) }, (_, i) =>
        Math.max(1, Math.min(n, Math.round(((i + 0.5) / Math.min(EPS_PER, n)) * n))),
      ))];
      return { malId: a.malId, title: a.title, eps: spots };
    });
  }
  throw new Error("need --malId or --top N");
}

/* ---------------- main ---------------- */
const t0 = Date.now();
const work = await buildWork();
const jobs = [];
for (const w of work) for (const ep of w.eps) jobs.push({ malId: w.malId, title: w.title, ep });
progress.total = jobs.length;
log(`cc-sync fleet: ${jobs.length} episodes, ${WORKERS} bots, lang=${LANG}, windows=${WINDOWS_WANT} (dsp correlation, no ASR)`);

let idx = 0;
async function bot(id) {
  // stagger the bots — simultaneous Zoko page hits at boot trip per-IP bursts
  await sleep((id - 1) * 5_000 + Math.random() * 1_500);
  for (;;) {
    const i = idx++;
    if (i >= jobs.length) return;
    const { malId, title, ep } = jobs[i];
    try {
      if (!FORCE) {
        const existing = await db.captionSync.findUnique({ where: { malId_ep_lang: { malId, ep, lang: LANG } } }).catch(() => null);
        if (existing && existing.confidence >= 0.6) {
          log(`[bot${id}] ${title} ep${ep}: cached conf=${existing.confidence} offset=${existing.offsetMs}ms — skip`);
          progress.done++; progress.results.push({ malId, title, ep, offsetMs: existing.offsetMs, confidence: existing.confidence, samples: existing.samples, status: "cached" });
          saveProgress();
          continue;
        }
      }
      const r = await measureEpisode(malId, ep, title);
      await persist(malId, title, r);
      const pretty = r.status === "ok"
        ? `offset=${(r.offsetMs / 1000).toFixed(2)}s conf=${r.confidence} (${r.samples}/${r.attempted} windows, spread=${(r.spreadMs / 1000).toFixed(2)}s)`
        : r.status;
      log(`[bot${id}] ${title} ep${ep}: ${pretty}`);
      progress.done++; progress.results.push({ malId, title, ep, status: r.status, offsetMs: r.offsetMs ?? null, confidence: r.confidence ?? null, samples: r.samples ?? 0 });
      saveProgress();
    } catch (e) {
      log(`[bot${id}] ${title} ep${ep}: ERROR ${String(e.message).slice(0, 120)}`);
      progress.done++; progress.results.push({ malId, title, ep, status: "error", detail: String(e.message).slice(0, 120) });
      saveProgress();
    }
  }
}

await Promise.all(Array.from({ length: Math.min(WORKERS, jobs.length) }, (_, i) => bot(i + 1)));
const mins = ((Date.now() - t0) / 60000).toFixed(1);
const measuredRows = progress.results.filter((r) => r.status === "ok" && r.offsetMs != null);
const drifts = measuredRows.map((r) => r.offsetMs / 1000);
console.log(`\nfleet done in ${mins}min — ${progress.done}/${progress.total} episodes, ${measuredRows.length} measured`);
if (drifts.length) {
  drifts.sort((a, b) => a - b);
  console.log(`drift s: min=${drifts[0].toFixed(2)} median=${drifts[Math.floor(drifts.length / 2)].toFixed(2)} max=${drifts[drifts.length - 1].toFixed(2)}`);
  const late = drifts.filter((d) => d >= 0.5).length;
  console.log(`episodes with captions >=0.5s LATE: ${late}/${drifts.length}`);
}
await db.$disconnect();
