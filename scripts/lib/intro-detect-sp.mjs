/**
 * SP-tuned intro detection for the South Park bot fleet.
 *
 * Ported from lib/intro-detect.mjs (the catalog intro-scout engine) with two
 * changes the show demands:
 *   - MP4 source: WCO serves direct MP4s (no HLS playlists), so the analyzer
 *     downloads the file (Range-capped) and decodes it with ffmpeg directly.
 *   - SP intro length: the theme runs ~31 s (later seasons) to ~44 s (S1-2) —
 *     the catalog engine's 45 s floor would reject EVERY SP opening. Here the
 *     plausible window is 25-90 s.
 *
 * The matching core is unchanged (Pearson slide + gain-fit mask carve):
 * the opening is the one part of an episode that repeats identically across
 * the season, so where envelopes align IS the opening — ±0.5 s accurate.
 */

const WIN_SEC = 0.5;
const MIN_OP_SEC = 25;
const MAX_OP_SEC = 90;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024; // SD encodes are ~13 MB; cap FHD stragglers
const DECODE_SEC = 240; // feed the first 4 minutes — SP cold opens end by ~2 min

export function curlTo(url, headers, timeoutMs) {
  return new Promise((res) => {
    const a = ["-sS", "--max-time", String(Math.ceil(timeoutMs / 1000)), "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", "-w", "\n__ST__%{http_code}", url];
    for (const [k, v] of Object.entries(headers ?? {})) a.push("-H", `${k}: ${v}`);
    import("node:child_process").then(({ execFile }) => {
      execFile("curl", a, { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs + 5_000 }, (e, out) => {
        const m = out.match(/__ST__(\d+)\s*$/);
        res({ status: m ? +m[1] : 0, body: out.replace(/__ST__\d+\s*$/, "") });
      });
    });
  });
}

/** Download (Range-capped, no Referer — WCO's fixed browser reality) to a temp file.
 *  UA matters: WCO's CDN hotlink-filters non-browser UAs (the fleet UA 404s). */
export function downloadMp4(url, tmpPath) {
  return new Promise((res) => {
    import("node:child_process").then(({ execFile }) => {
      execFile(
        "curl",
        ["-sS", "--max-time", "90", "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", "-r", `0-${MAX_DOWNLOAD_BYTES - 1}`, "-o", tmpPath, "-w", "%{http_code} %{size_download}", url],
        { maxBuffer: 8 * 1024 * 1024, timeout: 100_000 },
        (e, stdout) => res({ out: stdout, err: e ? String(e).slice(0, 100) : null }),
      );
    });
  });
}

/** Decode the first DECODE_SEC of audio to mono 8 kHz s16le PCM. */
export function decodePcm(path) {
  return new Promise((res) => {
    import("node:child_process").then(({ execFile }) => {
      execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", path, "-t", String(DECODE_SEC), "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], { maxBuffer: 16 * 1024 * 1024, timeout: 120_000, encoding: "buffer" }, (e, stdout, stderr) => {
        res({ pcm: e ? null : stdout, err: e ? String(stderr).slice(0, 140) : null });
      });
    });
  });
}

/** Moving-average smoothing — SP's theme mix varies slightly per episode/rip
 *  (original vs remastered rips), so RAW-envelope correlation only reaches
 *  ~0.6; a ±3 s average lifts the true alignment to 0.9+ while transient
 *  vocal timing differences wash out. */
function smoothEnv(env, k = 6) {
  return env.map((_, i) => {
    let s = 0, c = 0;
    for (let d = -k; d <= k; d++) {
      const j = i + d;
      if (j >= 0 && j < env.length) { s += env[j]; c++; }
    }
    return Math.round((s / c) * 1000) / 1000;
  });
}

/** PCM -> normalized RMS envelope at 0.5 s steps + loud-wall candidates.
 *  Walls come off the smoothed envelope (the theme is a sustained loud run;
 *  raw transients fragment it). */
export function envelopeFromPcm(pcm) {
  const win = 4000; // 0.5 s @ 8 kHz samples
  const raw = [];
  for (let off = 0; off + win * 2 <= pcm.length; off += win * 2) {
    let sum = 0;
    for (let i = 0; i < win; i++) sum += pcm.readInt16LE(off + i * 2) ** 2;
    raw.push(Math.sqrt(sum / win));
  }
  if (raw.length < 60) return null;
  const sorted = [...raw].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
  const env = raw.map((v) => Math.round((v / p95) * 1000) / 1000);
  const envS = smoothEnv(env);
  return { env, envS, analyzedSec: raw.length * WIN_SEC, walls: wallsOf(envS) };
}

function wallsOf(env) {
  const loud = env.map((v) => v >= 0.5);
  const merged = [];
  let i = 0;
  while (i < loud.length) {
    if (!loud[i]) { i++; continue; }
    let j = i;
    while (j < loud.length && (loud[j] || (j + 2 < loud.length && (loud[j + 1] || loud[j + 2])))) j++;
    merged.push([i, j]);
    i = j + 1;
  }
  const cands = [];
  for (const [a, b] of merged) {
    const s = a * WIN_SEC, e = b * WIN_SEC;
    if (s > 330) break;
    const dur = e - s;
    if (dur < MIN_OP_SEC || dur > MAX_OP_SEC + 60) continue;
    let loudN = 0, sum = 0;
    for (let k = a; k < b; k++) { if (env[k] >= 0.35) loudN++; sum += env[k]; }
    const frac = loudN / (b - a);
    if (frac < 0.72) continue;
    cands.push({ start: Math.round(s * 10) / 10, end: Math.round(e * 10) / 10, score: frac * (sum / (b - a)) });
  }
  return cands.sort((x, y) => y.score - x.score).slice(0, 3).map(({ start, end }) => ({ start, end }));
}

export function plausibleInterval(start, end) {
  const dur = end - start;
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start <= 320 && dur >= MIN_OP_SEC && dur <= MAX_OP_SEC;
}

/**
 * Slide `refEnv`'s opening over `env`; the aligned region in env's timeline
 * is the opening. Alignment runs on SMOOTHED envelopes (theme mixes vary per
 * rip), then the exact edges get carved on the RAW envelopes at the found
 * offset — smoothing buys robust matching without blurring the answer.
 * (Ported from matchEnvelope — Pearson pass + gain-fit mask carve.)
 */
export function matchEnvelope(env, refEnv, refInt) {
  if (!env.length || !refEnv.length) return null;
  const envS = smoothEnv(env);
  const refS = smoothEnv(refEnv);
  const len = refInt.end - refInt.start;
  let aS = Math.max(0, Math.round((refInt.start + len * 0.15) / WIN_SEC));
  let aE = Math.min(refS.length, Math.round((refInt.end - len * 0.1) / WIN_SEC));
  if (aE - aS < Math.floor(30 / WIN_SEC)) { aS = Math.max(0, Math.round(refInt.start / WIN_SEC)); aE = Math.min(refS.length, Math.round(refInt.end / WIN_SEC)); }
  if (aE - aS < 20) return null;
  const anchor = refS.slice(aS, aE);
  const n = anchor.length;

  let best = null;
  const maxO = envS.length - aE;
  for (let o = -aS; o <= maxO; o++) {
    let sab = 0, sa = 0, sb = 0, saa = 0, sbb = 0;
    for (let i = 0; i < n; i++) {
      const a = anchor[i], b = envS[o + aS + i];
      sab += a * b; sa += a; sb += b; saa += a * a; sbb += b * b;
    }
    const num = n * sab - sa * sb;
    const den = Math.sqrt((n * saa - sa * sa) * (n * sbb - sb * sb) + 1e-9);
    const corr = num / den;
    if (!best || corr > best.corr) best = { o, corr };
  }
  if (!best || best.corr < 0.72) return null;
  const o = best.o;

  // edges: gain-fit mask on the RAW envelopes at the found offset
  let sab = 0, saa = 0, sa = 0, sb = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    const a = refEnv[aS + i], b = env[o + aS + i];
    if (a > 0.12 && b > 0.12) { sab += a * b; saa += a * a; sa += a; sb += b; cnt++; }
  }
  let gain = 1, bias = 0;
  if (cnt > 20 && saa > 0) {
    const aMean = sa / cnt, bMean = sb / cnt;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      const a = refEnv[aS + i], b = env[o + aS + i];
      if (a > 0.12 && b > 0.12) { num += (a - aMean) * (b - bMean); den += (a - aMean) * (a - aMean); }
    }
    if (den > 1e-6) {
      gain = Math.min(4, Math.max(0.25, num / den));
      bias = bMean - gain * aMean;
    }
  }

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
