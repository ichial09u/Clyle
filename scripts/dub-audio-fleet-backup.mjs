/**
 * Fleet DUB-AUDIO verifier — BACKUP network edition (Anivexa providers).
 *
 * Extends the Dandadan-methodology audio check to the backup DUB servers
 * (AniNeko / AnimeGG / AniWatch / AllManga / Reanime). The main-chain fleet
 * (dub-audio-fleet.mjs) could trust MD5 equality because Zoko/Kiwi mux sub
 * and dub from the same encode pipeline. Backup providers DO NOT — their
 * sub and dub can come from entirely different uploads, so byte equality is
 * almost never informative and a mismatch means nothing. The verdict chain
 * here is therefore:
 *
 *   1. MD5 of the decoded 12s windows still wins when it matches
 *      (same audio bytes = fake, whatever the container).
 *   2. Loudness-envelope correlation (RMS @0.5s steps, Pearson): the same
 *      underlying audio survives re-encode with a near-identical envelope,
 *      while a real English dub diverges from the Japanese track. r >= 0.97
 *      = same-audio suspect.
 *   3. ASR (z-ai) on the DUB window is the authoritative cross-encode
 *      method: Japanese transcript (kana/CJK) = FAKE, English words = REAL.
 *      Envelope suspects without a readable transcript are recorded fake
 *      (honesty bias: we would rather drop a dub than serve Japanese audio
 *      labelled DUB — the original DAN DA DAN bug).
 *
 * For each (anime, ep, provider):
 *   - coverage gate: Anivexa /episodes says the provider lists THIS episode
 *     as dub, and its title roughly matches ours (Bocchi-for-Edgerunners
 *     guard — a wrong-show match must never yield a verdict)
 *   - resolve dub + sub watch streams, download the segments covering a
 *     dialogue window (~40% in, fallback 55%), decode, compare, transcribe
 *   - upsert DubAudio(malId, ep, server="anivexa-<provider>")
 *
 * Usage:
 *   node scripts/dub-audio-fleet-backup.mjs --malId 21 [--eps 1156-1160] \
 *        [--providers anineko,reanime] [--force]
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const BASE = (process.env.ANIVEXA_API_BASE || "https://anivexa-api.vercel.app").replace(/\/+$/, "");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PROVIDERS = ["anineko", "animegg", "hianime", "allmanga", "reanime"];
const ENV_FAKE_R = 0.97; // envelope correlation at/above this = same-audio suspect

const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true) : def;
};
const malId = parseInt(flag("malId"), 10);
const epsArg = flag("eps", "1");
const provArg = String(flag("providers", PROVIDERS.join(","))).split(",").filter(Boolean);
const force = flag("force") === true;

function epsRange(spec) {
  const m = String(spec).match(/^(\d+)(-(\d+))?$/);
  if (!m) return [1];
  const a = parseInt(m[1], 10), b = m[3] ? parseInt(m[3], 10) : a;
  return Array.from({ length: Math.max(1, b - a + 1) }, (_, i) => a + i);
}

/* --------------------------- anilist id mapping --------------------------- */
// Layer 1: the app's own anilist-cache (key = MediaByMal:{vars} sha1[:24]) —
// instant, offline, covers every anime the site has rendered recently.
// Layer 2: live AniList GraphQL (rate-limit friendly, disk-cached in
// db/al-map.json). When AniList is down (it answers 403 "temporarily
// disabled" during stability incidents) layer 1 still carries the sweep.

import { createHash } from "node:crypto";
const AL_CACHE_DIR = join(process.cwd(), "db", "anilist-cache");
const AL_MAP = join(process.cwd(), "db", "al-map.json");
let alMap = {};
if (existsSync(AL_MAP)) { try { alMap = JSON.parse(readFileSync(AL_MAP, "utf8")); } catch {} }
const titleSynonyms = {};

function alIdFromDiskCache(id) {
  const key = `MediaByMal:${JSON.stringify({ idMal: id })}`;
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 24);
  try {
    const entry = JSON.parse(readFileSync(join(AL_CACHE_DIR, `${hash}.json`), "utf8"));
    const m = entry?.data?.Media;
    if (m?.id) {
      alMap[id] = m.id;
      // remember every title form for the any-of guard
      titleSynonyms[id] = [m.title?.romaji, m.title?.english, ...(m.synonyms ?? [])].filter(Boolean);
      return m.id;
    }
  } catch {}
  return null;
}

async function anilistIdForMal(id) {
  if (alMap[id]) return alMap[id];
  const cached = alIdFromDiskCache(id);
  if (cached) { try { writeFileSync(AL_MAP, JSON.stringify(alMap)); } catch {} return cached; }
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA },
    body: JSON.stringify({ query: "query($id:Int){Media(idMal:$id,type:ANIME){id}}", variables: { id } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  const al = json?.data?.Media?.id ?? null;
  if (al) {
    alMap[id] = al;
    try { writeFileSync(AL_MAP, JSON.stringify(alMap)); } catch {}
  }
  return al;
}

/* ------------------------------ anivexa api ------------------------------ */

const hdrs = (referer) => (referer ? { "User-Agent": UA, Accept: "*/*", Referer: referer } : { "User-Agent": UA, Accept: "*/*" });

function titlesRoughlyMatch(a, b) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const x = norm(a), y = norm(b);
  if (!x || !y) return true;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const tx = new Set(x.split(" ")), ty = new Set(y.split(" "));
  let inter = 0;
  for (const t of tx) if (ty.has(t)) inter++;
  return inter / (Math.min(tx.size, ty.size) || 1) >= 0.6;
}

/** Any-of guard: providers name shows in romaji ("youjo senki"), we store
 * English ("Saga of Tanya the Evil"). The anilist-cache Media entry carries
 * BOTH forms — a meta title matching either is the same show. The
 * Bocchi-for-Edgerunners swap still dies (matches neither). */
function metaMatchesShow(metaTitle, titles) {
  if (!metaTitle) return true; // nothing to compare — don't block
  return titles.some((t) => titlesRoughlyMatch(t, metaTitle));
}

/** Per-provider episode lists (mirror of lib/anivexa.ts — script-local).
 * Cold fetches measured ~20s — two tries at 30s each. */
async function anivexaEpisodes(alId) {
  for (let tries = 0; tries < 2; tries++) {
    try {
      const res = await fetch(`${BASE}/episodes/${alId}`, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return null;
      const json = await res.json().catch(() => null);
      if (json && typeof json === "object" && (json.anineko || json.allmanga || json.reanime || json.animegg || json.hianime)) return json;
    } catch {}
    if (tries === 0) await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

/** Streams for one provider/ep/lang (null = provider said nothing usable). */
async function anivexaWatch(provider, alId, lang, ep) {
  const res = await fetch(`${BASE}/watch/${provider}/${alId}/${lang}/${provider}-${ep}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  if (!json || json.error) return null;
  const streams = (json.streams ?? []).filter((s) => s && s.url);
  return streams.length ? streams : null;
}

/** Every direct-media stream, HLS first then provider priority.
 * The watch payload lists MIRRORS (AniNeko's vibevibe worker can 403 while
 * the vivibebe mirror plays) — the caller walks the list until one yields
 * a real playlist, exactly like the app's resolve path. */
function pickStreams(streams) {
  return [...streams]
    .filter((s) => !s.embed || /\.m3u8(\?|$)/i.test(s.url ?? ""))
    .sort((a, b) => {
      const ah = /\.m3u8(\?|$)/i.test(a.url ?? "") ? 1 : 0;
      const bh = /\.m3u8(\?|$)/i.test(b.url ?? "") ? 1 : 0;
      if (ah !== bh) return bh - ah;
      return (b.priority ?? 0) - (a.priority ?? 0);
    });
}

/** First stream in `candidates` whose playlist yields usable segments AND
 * whose first segment carries real media bytes (vivibebe ad-walls list
 * extension-less ad-image URLs that pass the extension filter — only the
 * magic bytes tell the truth). */
async function resolvePlaylist(candidates, what, label) {
  for (const s of candidates.slice(0, 3)) {
    try {
      const P = await playlist(s.url, s.referer ?? null);
      if (!P.segs.length) {
        console.log(`${label}: ${what} playlist empty @ ${new URL(s.url).host} — next mirror`);
        continue;
      }
      const probe = await downloadSeg(P.segs[0].url, s.referer ?? null);
      if (probe.length < 50_000) {
        console.log(`${label}: ${what} first segment tiny (${probe.length}B) — ad-wall? next mirror`);
        continue;
      }
      return { P, referer: s.referer ?? null, url: s.url };
    } catch (e) {
      console.log(`${label}: ${what} mirror ERR ${String(e.message).slice(0, 60)} — next mirror`);
    }
  }
  return null;
}

/* --------------------------- playlist + segments -------------------------- */

/** master -> highest variant -> segment list [{url,start,dur}], totalDur */
async function playlist(masterUrl, referer) {
  const mres = await fetch(masterUrl, { headers: hdrs(referer), redirect: "follow", signal: AbortSignal.timeout(15_000) });
  if (!mres.ok) return { segs: [], total: 0 };
  const mtext = await mres.text();
  if (!mtext.includes("#EXTM3U")) return { segs: [], total: 0 };
  const uris = mtext.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  let mediaUrl = masterUrl;
  if (mtext.includes("#EXT-X-STREAM-INF")) {
    // master: pick the last (usually highest) variant that answers
    let chosen = null;
    for (const v of [...uris].reverse().slice(0, 2)) {
      const vurl = new URL(v, masterUrl).href;
      try {
        const vres = await fetch(vurl, { headers: hdrs(referer), redirect: "follow", signal: AbortSignal.timeout(12_000) });
        if (vres.ok) {
          const vtext = await vres.text();
          if (vtext.includes("#EXTM3U")) { chosen = { url: vurl, text: vtext }; break; }
        }
      } catch {}
    }
    if (!chosen) return { segs: [], total: 0 };
    mediaUrl = chosen.url;
    var text = chosen.text;
  } else {
    var text = mtext; // single-variant master IS the media playlist
  }
  const lines = text.split(/\r?\n/);
  const segs = [];
  let t = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#EXTINF:([\d.]+)/);
    if (m) {
      const dur = parseFloat(m[1]);
      const url = (lines[i + 1] ?? "").trim();
      if (url && !url.startsWith("#") && !/\.(jpg|jpeg|png|gif|webp|svg|html?)(\?|$)/i.test(url)) {
        segs.push({ url: new URL(url, mediaUrl).href, start: t, dur });
        t += dur;
      }
    }
  }
  return { segs, total: t };
}

async function downloadSeg(url, referer) {
  const res = await fetch(url, { headers: hdrs(referer), redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`seg ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 50_000) throw new Error(`tiny seg (${buf.length}B)`);
  if (buf[0] !== 0x47) {
    const head = buf.slice(0, 640).toString("latin1");
    if (!head.includes("ftyp") && !head.startsWith("ID3")) throw new Error("not media bytes");
  }
  return buf;
}

/* ------------------------------ audio analysis ---------------------------- */

/** MD5 of the decoded [off, off+12s) mono 16k window of a TS/fMP4 file. */
function windowMd5(segFile, offsetInSeg) {
  return execFileSync("ffmpeg", [
    "-v", "error", "-i", segFile, "-ss", String(Math.max(0, offsetInSeg).toFixed(2)),
    "-t", "12", "-vn", "-ac", "1", "-ar", "16000", "-f", "md5", "-",
  ], { encoding: "utf8" }).trim();
}

/** RMS envelope @0.5s steps of the decoded window (normalized 0..1). */
function envOf(segFile, offsetInSeg) {
  const raw = execFileSync("ffmpeg", [
    "-v", "error", "-i", segFile, "-ss", String(Math.max(0, offsetInSeg).toFixed(2)),
    "-t", "12", "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "-",
  ], { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 });
  const n = Math.floor(raw.length / 2);
  if (n < 8000) return null; // <1s of audio — useless
  const samples = new Int16Array(raw.buffer, raw.byteOffset, n);
  const step = 4000; // 0.5s @ 8kHz
  const env = [];
  for (let i = 0; i + step <= n; i += step) {
    let s = 0;
    for (let j = i; j < i + step; j++) { const v = samples[j] / 32768; s += v * v; }
    env.push(Math.sqrt(s / step));
  }
  const max = Math.max(...env, 1e-9);
  return env.map((v) => v / max);
}

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 6) return 0;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, dbv = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; dbv += y * y;
  }
  const den = Math.sqrt(da * dbv) || 1e-9;
  return num / den;
}

/** z-ai ASR on a 16k mono wav -> {lang: ja|en|unknown, text} */
function asrClassify(wav) {
  try {
    const b64 = readFileSync(wav).toString("base64");
    const out = execFileSync("z-ai", ["asr", "--base64", b64, "-o", join(tmpdir(), `asr-bk-${Date.now()}.json`)], { encoding: "utf8", timeout: 120_000 });
    const f = out.match(/File saved to: (\S+)/)?.[1];
    if (!f) return { lang: "unknown", text: "" };
    const text = JSON.parse(readFileSync(f, "utf8")).text ?? "";
    const jp = /[\u3040-\u30ff\u4e00-\u9fff]/.test(text);
    const enWords = (text.match(/[A-Za-z]{2,}/g) ?? []).length;
    return { text, lang: jp ? "ja" : enWords >= 3 ? "en" : text.trim() ? "en" : "unknown" };
  } catch (e) {
    return { lang: "unknown", text: "", err: String(e.message).slice(0, 120) };
  }
}

function toWav(segFile, offsetInSeg, outFile) {
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-i", segFile, "-ss", String(Math.max(0, offsetInSeg).toFixed(2)),
    "-t", "14", "-vn", "-ac", "1", "-ar", "16000", outFile,
  ]);
}

/* --------------------------------- verdict -------------------------------- */

/**
 * Compare one (dubSegFile, subSegFile) pair at the shared timestamp T.
 * Returns {verdict, method, detail} or null (inconclusive).
 */
function verdictForPair(dFile, dOff, sFile, sOff, T) {
  const dMd5 = windowMd5(dFile, dOff);
  const sMd5 = windowMd5(sFile, sOff);
  const detail0 = `t=${Math.round(T)}s`;
  if (dMd5 === sMd5) {
    return { verdict: "fake", method: "audio-md5", detail: `${detail0} identical decoded audio` };
  }
  const dEnv = envOf(dFile, dOff);
  const sEnv = envOf(sFile, sOff);
  const r = dEnv && sEnv ? pearson(dEnv, sEnv) : 0;
  const detail1 = `${detail0} env r=${r.toFixed(3)}`;
  // ASR the dub window — the authoritative cross-encode signal
  const wav = dFile.replace(/\.ts$/, "").replace(/\.m4s$/, "") + "-dub.wav";
  try { toWav(dFile, dOff, wav); } catch { return null; }
  const a1 = asrClassify(wav);
  if (a1.lang === "ja") return { verdict: "fake", method: "asr-ja", detail: `${detail1} asr=ja "${a1.text.slice(0, 60)}"` };
  if (a1.lang === "en") return { verdict: "real", method: "asr-en", detail: `${detail1} asr=en "${a1.text.slice(0, 60)}"` };
  // transcript unreadable — the envelope decides (same content survives re-encode)
  if (r >= ENV_FAKE_R) return { verdict: "fake", method: "env-corr", detail: `${detail1} asr=unknown -> same-audio envelope` };
  if (r > 0 && r < ENV_FAKE_R) return { verdict: "real", method: "audio-env", detail: `${detail1} asr=unknown -> audio differs` };
  return null; // no audio at all — try the other window
}

/* ---------------------------------- main ---------------------------------- */

const workdir = mkdtempSync(join(tmpdir(), "dubaudbk-"));
const animeRow = await db.anime.findUnique({ where: { malId }, select: { title: true, titleEnglish: true } });
const ourTitle = animeRow?.titleEnglish?.trim() || animeRow?.title || "";
const alId = await anilistIdForMal(malId);
if (!alId) { console.log(`no anilist id for mal ${malId} — abort`); process.exit(1); }
// al-map hit may have skipped the disk-cache read — synthesize synonyms anyway
if (!titleSynonyms[malId]) alIdFromDiskCache(malId);
if (!titleSynonyms[malId]) titleSynonyms[malId] = [ourTitle];

const epsData = await anivexaEpisodes(alId).catch(() => null);
if (!epsData) { console.log(`anivexa episodes unreachable for al ${alId} — abort`); process.exit(1); }

for (const ep of epsRange(epsArg)) {
  for (const provider of provArg) {
    const server = `anivexa-${provider}`;
    const label = `ep${ep}-${provider}`;
    if (!force) {
      const existing = await db.dubAudio.findUnique({ where: { malId_ep_server: { malId, ep, server } } }).catch(() => null);
      if (existing) { console.log(`${label}: already ${existing.verdict} — skip`); continue; }
    }
    try {
      // coverage gate: provider must DECLARE this episode as dub, right show
      const p = epsData[provider];
      if (!p || p.error) { console.log(`${label}: provider down/unavailable — skip`); continue; }
      const metaTitle = p.meta?.title?.trim();
      if (metaTitle && !metaMatchesShow(metaTitle, titleSynonyms[malId] ?? [ourTitle])) { console.log(`${label}: WRONG-SHOW match "${metaTitle}" — skip`); continue; }
      const dubList = (p.episodes?.dub ?? []).map((e) => Math.floor(e.number)).filter(Number.isFinite);
      if (!dubList.includes(ep)) { console.log(`${label}: provider does not declare dub for this ep — skip`); continue; }

      // resolve both language streams from THIS provider
      const [dWatch, sWatch] = await Promise.all([
        anivexaWatch(provider, alId, "dub", ep),
        anivexaWatch(provider, alId, "sub", ep),
      ]);
      const dCands = dWatch ? pickStreams(dWatch) : [];
      const sCands = sWatch ? pickStreams(sWatch) : [];
      if (!dCands.length) { console.log(`${label}: no usable dub HLS — inconclusive`); continue; }
      if (!sCands.length) { console.log(`${label}: no usable sub HLS to compare — inconclusive`); continue; }
      const [dR, sR] = await Promise.all([
        resolvePlaylist(dCands, "dub", label),
        resolvePlaylist(sCands, "sub", label),
      ]);
      if (!dR || !sR) { console.log(`${label}: no mirror yielded segments — inconclusive`); continue; }
      const Pd = dR.P, dRef = dR.referer;
      const Ps = sR.P, sRef = sR.referer;

      // two dialogue windows: 40% then 55% (both past the OP on every show)
      let verdict = null;
      for (const frac of [0.4, 0.55]) {
        const T = Math.min(Pd.total, Ps.total) * frac;
        const pick = (P) => P.segs.find((s) => T >= s.start && T < s.start + s.dur) ?? P.segs[Math.floor(P.segs.length * frac)];
        const dSeg = pick(Pd), sSeg = pick(Ps);
        if (!dSeg || !sSeg) continue;
        let dBuf, sBuf;
        try {
          [dBuf, sBuf] = await Promise.all([downloadSeg(dSeg.url, dRef), downloadSeg(sSeg.url, sRef)]);
        } catch (e) {
          console.log(`${label}: window ${frac} download ERR ${String(e.message).slice(0, 50)} — try next window`);
          continue; // one dead segment must not kill the episode
        }
        const dF = join(workdir, `${label}-d${frac}.ts`); writeFileSync(dF, dBuf);
        const sF = join(workdir, `${label}-s${frac}.ts`); writeFileSync(sF, sBuf);
        verdict = verdictForPair(dF, T - dSeg.start, sF, T - sSeg.start, T);
        if (verdict) break;
      }
      if (!verdict) { console.log(`${label}: both windows inconclusive (no decodable audio) — skip`); continue; }

      await db.dubAudio.upsert({
        where: { malId_ep_server: { malId, ep, server } },
        create: { malId, ep, server, verdict: verdict.verdict, method: verdict.method, detail: verdict.detail },
        update: { verdict: verdict.verdict, method: verdict.method, detail: verdict.detail, checkedAt: new Date() },
      });
      console.log(`${label}: ${verdict.verdict.toUpperCase()} (${verdict.method}) ${verdict.detail.slice(0, 90)}`);
    } catch (e) {
      console.log(`${label}: ERROR ${String(e.message).slice(0, 140)}`);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
}
console.log("done");
await db.$disconnect();
