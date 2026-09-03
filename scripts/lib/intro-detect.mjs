/**
 * Intro-detection engine for the Clyle intro-scout bot fleet.
 *
 * A bot "watches" an episode the same way the player does: it opens the
 * episode's real HLS playlist, streams the first minutes through ffmpeg and
 * listens. The opening is the one part of an episode that is IDENTICAL
 * across episodes of a show — so the fleet's core trick is comparison:
 *
 *   1. analyzePlaylist()  — master.m3u8 -> variant -> segments piped into
 *      ffmpeg (-ac 1 -ar 8000 s16le) -> 0.5 s RMS loudness envelope.
 *      Downloading early-stops as soon as the decision is made.
 *   2. proposeWall()      — first long "loud wall" (the OP is wall-to-wall
 *      music; dialogue is choppy). A ROUGH seed, good for budgeting only.
 *   3. matchEnvelope()    — the precise instrument: slide one episode's
 *      normalized envelope over another's (or over a stored per-anime
 *      reference) and find where they align. The opening aligns perfectly
 *      (same file, same mix); dialogue never does. This is what makes the
 *      reported start/end accurate to ±0.5 s — including shows whose OP
 *      position shifts due to recaps.
 *
 * Pure functions, no state, no DB. The fleet script (intro-scout.mjs)
 * decides what to scan and what to do with the answer.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const DEFAULT_HEADERS = {
  "User-Agent": UA,
  Origin: "https://zokoanime.video",
  Referer: "https://zokoanime.video/",
};

const WIN_SEC = 0.5; // envelope resolution
const MAX_ANALYZE_SEC = 400; // hard cap of stream fed into ffmpeg
const SOFT_CAP_SEC = 330; // feed at least this much before trusting "no wall"
const MIN_OP_SEC = 45; // shortest believable opening
const MAX_OP_SEC = 150; // longest believable opening

/* ------------------------------------------------------------------ *
 * HLS -> PCM -> envelope
 * ------------------------------------------------------------------ */

/**
 * Stream one episode's first minutes and return its loudness envelope.
 * @param {string} masterUrl  direct HLS master playlist URL
 * @param {object} [opts]     { headers, log, minSec, maxSec }
 * @returns {Promise<{status:"ok"|"error", env:number[], analyzedSec:number,
 *                    wall:{start:number,end:number}|null, p95:number, detail:string}>}
 *   env: RMS per 0.5 s window, normalized by the episode's p95 (0..~1.5)
 *   wall: proposed loud-wall region (SECONDS) or null
 */
export async function analyzePlaylist(masterUrl, opts = {}) {
  const headers = { ...DEFAULT_HEADERS, ...(opts.headers ?? {}) };
  const log = opts.log ?? (() => {});
  const t0 = Date.now();
  const minSec = opts.minSec ?? 150; // always feed at least this much
  const maxSec = Math.min(opts.maxSec ?? MAX_ANALYZE_SEC, MAX_ANALYZE_SEC);

  try {
    // ---- master -> variant ------------------------------------------
    const mres = await fetch(masterUrl, { headers, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!mres.ok) return { status: "error", env: [], analyzedSec: 0, wall: null, p95: 0, detail: `master -> ${mres.status}` };
    const master = await mres.text();
    const variantLine = master.split("\n").find((l) => l.trim() && !l.startsWith("#"));
    if (!variantLine) return { status: "error", env: [], analyzedSec: 0, wall: null, p95: 0, detail: "master has no variant" };
    const variantUrl = new URL(variantLine.trim(), masterUrl).href;

    // ---- variant -> segment plan --------------------------------------
    const vres = await fetch(variantUrl, { headers, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!vres.ok) return { status: "error", env: [], analyzedSec: 0, wall: null, p95: 0, detail: `variant -> ${vres.status}` };
    const vtext = await vres.text();
    const segs = [];
    let pend = null;
    for (const line of vtext.split("\n")) {
      const t = line.trim();
      if (t.startsWith("#EXTINF:")) pend = parseFloat(t.slice(8));
      else if (t && !t.startsWith("#")) {
        if (pend == null || !Number.isFinite(pend)) pend = 4;
        segs.push({ url: new URL(t, variantUrl).href, dur: pend });
        pend = null;
        if (segs.reduce((a, s) => a + s.dur, 0) >= maxSec) break;
      }
    }
    if (!segs.length) return { status: "error", env: [], analyzedSec: 0, wall: null, p95: 0, detail: "variant has no segments" };

    // ---- pipe through ffmpeg, collect envelope ------------------------
    const { spawn } = await import("node:child_process");
    const child = spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-analyzeduration", "20M", "-probesize", "20M",
       "-i", "pipe:0", "-map", "0:a:0?", "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let ffErr = "";
    child.stderr.on("data", (d) => { ffErr = (ffErr + d).slice(-400); });
    const ffDead = new Promise((resolve) => {
      child.on("close", (code) => resolve(code));
      child.on("error", () => resolve(-1));
    });

    const an = new PcmScanner();
    let fedSec = 0;
    let target = minSec; // grows if a wall candidate needs more tail

    const pump = (async () => {
      let segIdx = 0;
      try {
        for (const seg of segs) {
          segIdx++;
          if (child.stdin.destroyed) break;
          let res;
          try {
            res = await fetch(seg.url, { headers, cache: "no-store", signal: AbortSignal.timeout(30_000) });
          } catch (e) {
            log(`segment fetch failed (${String(e).slice(0, 80)}) — analyzing what we have`);
            break;
          }
          if (!res.ok || !res.body) { log(`segment -> ${res.status}, stopping feed`); break; }
          const reader = res.body.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!child.stdin.destroyed && !child.stdin.writableEnded) {
                if (!child.stdin.write(value)) {
                  await new Promise((r) => child.stdin.once("drain", r));
                }
              }
            }
          } catch (e) {
            log(`segment read aborted (${String(e).slice(0, 80)})`);
            break;
          }
          fedSec += seg.dur;
          if (segIdx % 20 === 0) log(`+${((Date.now() - t0) / 1000).toFixed(1)}s fed ${segIdx}/${segs.length} segs, media ${fedSec.toFixed(0)}s`);
          // budget rules: reach minSec, then stop once a wall has end+tail in hand
          if (fedSec >= target) break;
          if (fedSec >= SOFT_CAP_SEC && an.wall() === null) break;
          if (fedSec >= maxSec) break;
        }
      } finally {
        // CRITICAL: ffmpeg only finishes once stdin closes — never leave it
        // open or the pipeline deadlocks (ffmpeg waits for input, we wait
        // for ffmpeg).
        try { child.stdin.end(); } catch { /* already gone */ }
      }
    })();

    const pcmOut = (async () => {
      for await (const chunk of child.stdout) an.absorb(chunk);
    })();
    void (async () => { for await (const _ of child.stderr) { /* discarded */ } })();

    // the pump may extend its own target when a wall needs more tail
    const budgetWatch = setInterval(() => {
      const w = an.wall();
      if (w && target < Math.min(w.end + 15, maxSec)) target = Math.min(w.end + 15, maxSec);
    }, 500);

    await Promise.race([
      Promise.all([pump, pcmOut, ffDead]),
      new Promise((r) => setTimeout(r, 10 * 60_000)),
    ]);
    clearInterval(budgetWatch);
    const exitCode = await Promise.race([ffDead, new Promise((r) => setTimeout(() => r(-2), 30_000))]);
    try { child.kill("SIGKILL"); } catch { /* fine */ }

    if (an.env.length < 60) {
      return { status: "error", env: [], analyzedSec: fedSec, wall: null, p95: 0, detail: `no audio (exit ${exitCode}) ${ffErr.slice(0, 120)}` };
    }
    const wall = an.wall();
    log(`+${((Date.now() - t0) / 1000).toFixed(1)}s analyzed ${an.mediaSec().toFixed(0)}s -> wall=${wall ? `${wall.start}-${wall.end}` : "none"}`);
    return { status: "ok", env: an.env, analyzedSec: an.mediaSec(), wall, p95: an.p95, detail: "" };
  } catch (err) {
    return { status: "error", env: [], analyzedSec: 0, wall: null, p95: 0, detail: String(err).slice(0, 200) };
  }
}

/** Incremental PCM -> RMS envelope (normalized in place at read time). */
class PcmScanner {
  constructor() {
    this.win = 4000; // 0.5 s @ 8 kHz
    this.buf = Buffer.alloc(0);
    this.raw = []; // RMS per window (int16 scale)
    this.totalSamples = 0;
  }

  absorb(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const n = Math.floor(this.buf.length / 2);
    const usable = n - (n % this.win);
    for (let w = 0; w < usable; w += this.win) {
      let sum = 0;
      for (let i = 0; i < this.win; i++) {
        const v = this.buf.readInt16LE((w + i) * 2);
        sum += v * v;
      }
      this.raw.push(Math.sqrt(sum / this.win));
      this.totalSamples += this.win;
    }
    const keep = this.buf.length - usable * 2;
    this.buf = keep ? Buffer.from(this.buf.subarray(this.buf.length - keep)) : Buffer.alloc(0);
    // p95 changes as data arrives; recompute lazily on read
    this._p95 = null;
  }

  mediaSec() {
    return this.totalSamples / 8000;
  }

  get p95() {
    if (this._p95 == null) {
      const sorted = [...this.raw].sort((a, b) => a - b);
      this._p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
    }
    return this._p95;
  }

  /** normalized envelope (recomputed view; raw stays int16-scale) */
  get env() {
    const p = this.p95;
    return this.raw.map((v) => Math.round((v / p) * 1000) / 1000);
  }

  /**
   * First "loud wall": a run of >= MIN_OP_SEC where windows stay loud
   * (>= 0.5 p95) with at most ~1 s quiet dips, starting within 0-330 s.
   * Returns SECONDS { start, end } or null.
   */
  wall() {
    if (this.raw.length < 90) return null;
    const p = this.p95;
    const env = this.env;
    const loud = env.map((v) => v >= 0.5);
    // merge loud runs separated by <= 2 windows (1 s)
    const merged = [];
    let i = 0;
    while (i < loud.length) {
      if (!loud[i]) { i++; continue; }
      let j = i;
      while (j < loud.length && (loud[j] || (j + 2 < loud.length && (loud[j + 1] || loud[j + 2])))) j++;
      merged.push([i, j]);
      i = j + 1;
    }
    for (const [a, b] of merged) {
      const s = a * WIN_SEC, e = b * WIN_SEC;
      if (s > 330) break;
      const dur = e - s;
      if (dur < MIN_OP_SEC || dur > MAX_OP_SEC + 60) continue;
      // wall quality: mostly loud inside
      let loudN = 0;
      for (let k = a; k < b; k++) if (env[k] >= 0.35) loudN++;
      if (loudN / (b - a) < 0.72) continue;
      return { start: Math.round(s * 10) / 10, end: Math.round(e * 10) / 10 };
    }
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Envelope matching — the precise instrument
 *
 * Pearson correlation is used because episodes of the same show have
 * different loudness dynamics (ep1's p95 may be the OP itself, ep2's may
 * be loud SFX after it) — correlation is gain/offset invariant, so the
 * opening aligns at corr > 0.9 even when its relative loudness differs,
 * while wrong offsets collapse (< 0.3). Alignment is razor-sharp: a half
 * second of slide typically costs 0.4+ of correlation.
 * ------------------------------------------------------------------ */

/**
 * Slide `refEnv`'s opening over `env` and find where they align.
 * Returns the matched interval IN `env`'s timeline (seconds).
 *
 * @param {number[]} env       episode envelope (normalized RMS, 0.5 s steps)
 * @param {number[]} refEnv    reference envelope (normalized RMS, 0.5 s steps)
 * @param {{start:number,end:number}} refInt  the OP interval inside refEnv (seconds)
 * @returns {{start:number,end:number,quality:number,gain:number}|null}
 */
export function matchEnvelope(env, refEnv, refInt) {
  if (!env.length || !refEnv.length) return null;

  // anchor = trimmed core of the reference interval (edges are where
  // transitions/noise live; the core is pure opening)
  const len = refInt.end - refInt.start;
  let aS = Math.max(0, Math.round((refInt.start + len * 0.15) / WIN_SEC));
  let aE = Math.min(refEnv.length, Math.round((refInt.end - len * 0.1) / WIN_SEC));
  if (aE - aS < Math.floor(30 / WIN_SEC)) { aS = Math.max(0, Math.round(refInt.start / WIN_SEC)); aE = Math.min(refEnv.length, Math.round(refInt.end / WIN_SEC)); }
  if (aE - aS < 20) return null;
  const anchor = refEnv.slice(aS, aE);
  const n = anchor.length;

  // ---- pass 1: best offset by Pearson correlation -------------------
  let best = null; // { o, corr }
  const maxO = env.length - aE;
  for (let o = -aS; o <= maxO; o++) {
    let sab = 0, sa = 0, sb = 0, saa = 0, sbb = 0;
    for (let i = 0; i < n; i++) {
      const a = anchor[i], b = env[o + aS + i];
      sab += a * b; sa += a; sb += b; saa += a * a; sbb += b * b;
    }
    const num = n * sab - sa * sb;
    const den = Math.sqrt((n * saa - sa * sa) * (n * sbb - sb * sb) + 1e-9);
    const corr = num / den;
    if (!best || corr > best.corr) best = { o, corr };
  }
  if (!best || best.corr < 0.72) return null;
  const o = best.o;

  // ---- pass 2: gain-fit + per-window mask to carve exact edges ------
  let sab = 0, saa = 0, sa = 0, sb = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    const a = anchor[i], b = env[o + aS + i];
    if (a > 0.12 && b > 0.12) { sab += a * b; saa += a * a; sa += a; sb += b; cnt++; }
  }
  let gain = 1, bias = 0;
  if (cnt > 20 && saa > 0) {
    const aMean = sa / cnt, bMean = sb / cnt;
    // recompute with means for a proper least-squares fit
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      const a = anchor[i], b = env[o + aS + i];
      if (a > 0.12 && b > 0.12) { num += (a - aMean) * (b - bMean); den += (a - aMean) * (a - aMean); }
    }
    if (den > 1e-6) {
      gain = Math.min(4, Math.max(0.25, num / den));
      bias = bMean - gain * aMean;
    }
  }

  // mask around the anchor: ±50 s to catch the true OP edges
  const mFrom = Math.max(0, aS - 100);
  const mTo = Math.min(refEnv.length, aE + 100);
  const maskLen = Math.min(mTo, env.length - o) - mFrom;
  if (maskLen < Math.floor(MIN_OP_SEC / WIN_SEC)) return null;
  const mask = new Array(maskLen);
  for (let k = 0; k < maskLen; k++) {
    const i = mFrom + k;
    const a = refEnv[i], b = env[i + o];
    const loudish = Math.max(a, b) > 0.1;
    mask[k] = loudish && Math.abs(gain * a + bias - b) < 0.16;
  }

  // longest gap-tolerant run (tolerate <= 4 s inside the song)
  const GAP_TOL = 8;
  let runStart = null, gap = 0, bestRun = null;
  for (let k = 0; k <= maskLen; k++) {
    if (k < maskLen && mask[k]) {
      if (runStart == null) runStart = k;
      gap = 0;
    } else if (runStart != null) {
      gap++;
      if (gap > GAP_TOL || k === maskLen) {
        const len2 = k - gap - runStart;
        if (!bestRun || len2 > bestRun.len) bestRun = { start: runStart, len: len2 };
        runStart = null;
        gap = 0;
      }
    }
  }
  if (!bestRun || bestRun.len < Math.floor(MIN_OP_SEC / WIN_SEC)) return null;

  // trim soft edges (unmasked tips)
  let s = bestRun.start, e = bestRun.start + bestRun.len;
  while (s < e && !mask[s]) s++;
  while (e > s && !mask[e - 1]) e--;
  const startSec = (mFrom + s + o) * WIN_SEC;
  const endSec = (mFrom + e + o) * WIN_SEC;
  if (!plausibleInterval(startSec, endSec)) return null;
  return {
    start: Math.round(startSec * 10) / 10,
    end: Math.round(endSec * 10) / 10,
    quality: Math.round(Math.min(1, best.corr) * 100) / 100,
    gain: Math.round(gain * 100) / 100,
  };
}

/** Sanity-check a detected interval. */
export function plausibleInterval(start, end) {
  const dur = end - start;
  return (
    Number.isFinite(start) && Number.isFinite(end) &&
    start >= 0 && start <= 320 && dur >= MIN_OP_SEC && dur <= MAX_OP_SEC
  );
}
