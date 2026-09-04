/**
 * Fleet DUB-AUDIO verifier — the offline half of the DAN DA DAN fix.
 *
 * The runtime's fake-dub check compares raw segment BYTES, but Zoko/Kiwi
 * sometimes mux the original JAPANESE audio into a DUB entry whose video is
 * a different encode — bytes differ, audio doesn't. Only a decoded-audio
 * comparison catches it, and that needs ffmpeg (local machine only — Vercel
 * serverless has none). This script is that comparison, fleet-grade:
 *
 *   for each (anime, ep, server):
 *     1. resolve sub + dub playlists (zoko payload decode, ?server=kiwi)
 *     2. pick a dialogue window (~40% into the episode, past the OP)
 *     3. download the segment covering that timestamp from BOTH streams and
 *        extract a timestamp-aligned 12s mono PCM window from each
 *     4. identical decoded-audio MD5  -> "fake" (Japanese audio, DUB label)
 *        different audio              -> "real" candidate
 *     5. --asr: transcribe the window (z-ai asr) — kana/CJK transcript
 *        overrides to "fake", English words confirm "real" (method asr-en)
 *     6. upsert DubAudio(malId, ep, server) + reconcile the anime-level
 *        hasDub / hasDubKiwi column when the verdict contradicts it
 *
 * Usage:
 *   node scripts/dub-audio-fleet.mjs --malId 57334 [--eps 1-12] \
 *        [--servers zoko,kiwi] [--asr] [--force]
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const ORIGIN = "https://zokoanime.video";
const KEY = "otaku-embed-v1";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const H = { "User-Agent": UA, Origin: ORIGIN, Referer: `${ORIGIN}/` };

const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true) : def;
};
const malId = parseInt(flag("malId"), 10);
const epsArg = flag("eps", "1");
const servers = String(flag("servers", "zoko,kiwi")).split(",");
const useAsr = flag("asr") === true;
const force = flag("force") === true;

function epsRange(spec) {
  const m = String(spec).match(/^(\d+)(-(\d+))?$/);
  if (!m) return [1];
  const a = parseInt(m[1], 10), b = m[3] ? parseInt(m[3], 10) : a;
  return Array.from({ length: Math.max(1, b - a + 1) }, (_, i) => a + i);
}

function xor(str) { let o = ""; for (let i = 0; i < str.length; i++) o += String.fromCharCode(str.charCodeAt(i) ^ KEY.charCodeAt(i % KEY.length)); return o; }
function decode(blob) { return JSON.parse(decodeURIComponent(escape(xor(atob(blob))))); }

async function payload(malId, ep, lang, server) {
  const url = server === "kiwi"
    ? `${ORIGIN}/stream/mal/${malId}/${ep}/${lang}?server=kiwi`
    : `${ORIGIN}/stream/mal/${malId}/${ep}/${lang}`;
  const res = await fetch(url, { headers: { ...H, Accept: "text/html" }, signal: AbortSignal.timeout(25_000) });
  if (res.status === 404 || res.status === 410) return null; // definitive: no page
  const html = await res.text();
  const m = html.match(/window\.__P="([^"]+)"/);
  return m ? decode(m[1]) : null;
}

/** master -> highest variant -> segment list [{url,start,dur}], totalDur */
async function playlist(masterUrl) {
  const mtext = await (await fetch(masterUrl, { headers: H, signal: AbortSignal.timeout(20_000) })).text();
  const variants = mtext.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  // prefer the 720p-ish middle variant: pick the last (often highest) but cap
  const vline = variants[Math.min(1, variants.length - 1)];
  const vurl = new URL(vline.trim(), masterUrl).href;
  const vtext = await (await fetch(vurl, { headers: H, signal: AbortSignal.timeout(20_000) })).text();
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

async function downloadSeg(url) {
  const res = await fetch(url, { headers: H, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`seg ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 50_000 || buf[0] !== 0x47) throw new Error(`not TS (${buf.length}B)`);
  return buf;
}

/** extract a timestamp-aligned audio window: [t0, t0+12s) of the episode */
function windowMd5(segFile, offsetInSeg) {
  const len = Math.min(12, 1e9);
  const out = execFileSync("ffmpeg", [
    "-v", "error", "-i", segFile, "-ss", String(Math.max(0, offsetInSeg).toFixed(2)),
    "-t", String(len), "-vn", "-ac", "1", "-ar", "16000", "-f", "md5", "-",
  ], { encoding: "utf8" }).trim();
  return out;
}

function asrClassify(wav) {
  try {
    const b64 = require("node:fs").readFileSync(wav).toString("base64");
    const out = execFileSync("z-ai", ["asr", "--base64", b64, "-o", join(tmpdir(), `asr-${Date.now()}.json`)], { encoding: "utf8", timeout: 120_000 });
    const f = out.match(/File saved to: (\S+)/)?.[1];
    if (!f) return { text: "", lang: "unknown" };
    const text = JSON.parse(require("node:fs").readFileSync(f, "utf8")).text ?? "";
    const jp = /[\u3040-\u30ff\u4e00-\u9fff]/.test(text);
    const enWords = (text.match(/[A-Za-z]{2,}/g) ?? []).length;
    return { text, lang: jp ? "ja" : enWords >= 3 ? "en" : text.trim() ? "en" : "unknown" };
  } catch (e) {
    return { text: "", lang: "unknown", err: String(e.message).slice(0, 120) };
  }
}

const workdir = mkdtempSync(join(tmpdir(), "dubaudfleet-"));
let i = 0;

for (const ep of epsRange(epsArg)) {
  for (const server of servers) {
    if (!force) {
      const existing = await db.dubAudio.findUnique({ where: { malId_ep_server: { malId, ep, server } } }).catch(() => null);
      if (existing) { console.log(`ep${ep} ${server}: already ${existing.verdict} — skip`); continue; }
    }
    const label = `ep${ep}-${server}`;
    try {
      const sub = await payload(malId, ep, "sub", server).catch(() => null);
      const dub = await payload(malId, ep, "dub", server).catch(() => null);
      if (!dub) { console.log(`${label}: no dub page — skip (absence handled elsewhere)`); continue; }
      if (!sub) { console.log(`${label}: no sub page to compare — inconclusive`); continue; }
      if (sub.src === dub.src) {
        await db.dubAudio.upsert({ where: { malId_ep_server: { malId, ep, server } }, create: { malId, ep, server, verdict: "fake", method: "audio-md5", detail: "same stream url" }, update: { verdict: "fake", method: "audio-md5", detail: "same stream url", checkedAt: new Date() } });
        console.log(`${label}: FAKE (same stream url)`); continue;
      }
      const [Psub, Pdub] = await Promise.all([playlist(sub.src), playlist(dub.src)]);
      if (!Psub.segs.length || !Pdub.segs.length) { console.log(`${label}: empty playlist — inconclusive`); continue; }
      // dialogue target: 40% in (OP is over by then on essentially every show)
      const T = Math.min(Psub.total, Pdub.total) * 0.4;
      const pick = (P) => P.segs.find((s) => T >= s.start && T < s.start + s.dur) ?? P.segs[Math.floor(P.segs.length * 0.4)];
      const sSeg = pick(Psub), dSeg = pick(Pdub);
      const [sBuf, dBuf] = await Promise.all([downloadSeg(sSeg.url), downloadSeg(dSeg.url)]);
      const sF = join(workdir, `${label}-sub.ts`); writeFileSync(sF, sBuf);
      const dF = join(workdir, `${label}-dub.ts`); writeFileSync(dF, dBuf);
      const sMd5 = windowMd5(sF, T - sSeg.start);
      const dMd5 = windowMd5(dF, T - dSeg.start);
      let verdict, method = "audio-md5", detail = `t=${Math.round(T)}s sub${sMd5} dub${dMd5}`;
      if (sMd5 === dMd5) {
        verdict = "fake";
      } else if (useAsr) {
        const wav = join(workdir, `${label}-dub.wav`);
        try { execFileSync("ffmpeg", ["-v", "error", "-y", "-i", dF, "-ss", String(Math.max(0, T - dSeg.start).toFixed(2)), "-t", "14", "-vn", "-ac", "1", "-ar", "16000", wav]); } catch {}
        const r = asrClassify(wav);
        if (r.lang === "ja") { verdict = "fake"; method = "asr-en"; detail += ` asr=ja "${r.text.slice(0, 60)}"`; }
        else if (r.lang === "en") { verdict = "real"; method = "asr-en"; detail += ` asr=en "${r.text.slice(0, 60)}"`; }
        else { verdict = "real"; detail += " asr=inconclusive"; }
      } else {
        verdict = "real";
      }
      await db.dubAudio.upsert({ where: { malId_ep_server: { malId, ep, server } }, create: { malId, ep, server, verdict, method, detail }, update: { verdict, method, detail, checkedAt: new Date() } });
      console.log(`${label}: ${verdict.toUpperCase()} (${method})`);
      // reconcile the anime-level column — a measured-fake contradicts "true"
      if (verdict === "fake") {
        const a = await db.anime.findUnique({ where: { malId }, select: { hasDub: true, hasDubKiwi: true } });
        if (a && server === "kiwi" && a.hasDubKiwi === true) { await db.anime.update({ where: { malId }, data: { hasDubKiwi: false } }); console.log(`  -> hasDubKiwi true->false`); }
        if (a && server === "zoko" && a.hasDub === true) { await db.anime.update({ where: { malId }, data: { hasDub: false } }); console.log(`  -> hasDub true->false`); }
      }
    } catch (e) {
      console.log(`${label}: ERROR ${String(e.message).slice(0, 140)}`);
    }
    await new Promise((r) => setTimeout(r, 800)); ++i;
  }
}
console.log("done");
await db.$disconnect();
