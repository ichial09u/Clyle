#!/usr/bin/env node
/**
 * SP CAPTION HARVEST — vendored English CC for every South Park episode.
 *
 * WCO ships no caption tracks for the show (getvidlink sub=null everywhere),
 * but the LM2 mirror catalog (lookmovie2) attaches OpenSubtitles-sourced
 * English WebVTT to every episode it carries. This harvester walks the whole
 * series (map: scripts/lm2-sp-map.json, extracted from LM2's show page),
 * downloads the best English VTT per episode, and stores it in SpCaption —
 * baked into the packaged DB and served same-origin by /api/captions/sp.
 *
 * Track pick per episode: among the English candidates prefer the one with
 * the most cues (full CC beats partial), tie-broken by the LAST cue landing
 * in the final quarter of the episode (full-episode coverage).
 *
 * The Movies & Specials bucket (999900) maps to LM2 as: ep1 = Streaming Wars
 * Part 2, ep2 = Streaming Wars (movie-access), ep3 = Bigger Longer & Uncut
 * (LM2 show S0E45). Subtitles ride the access calls even where LM2's movie
 * VIDEO storage is broken ("WRONG HASH") — captions are independent of it.
 *
 * Resumable: progress in scripts/sp-caption-progress.json.
 * Usage: node scripts/sp-caption-harvest.mjs [--seconds 570] [--lanes 3]
 * Runs until the time budget is exhausted (sandbox-friendly chunking), then
 * exits cleanly. Re-run until "ALL DONE".
 */
import { execFile } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

process.env.DATABASE_URL = "file:/home/z/my-project/src/db/custom.db";
const { PrismaClient } = await import("/home/z/my-project/src/node_modules/@prisma/client/index.js").then((m) => ({ PrismaClient: m.PrismaClient }));
const db = new PrismaClient();

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SITE = "https://www.lookmovie2.to";
const SHOW_PLAY = `${SITE}/shows/play/1689878855-south-park-1997`;
const PROGRESS = new URL("./sp-caption-progress.json", import.meta.url).pathname;

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BUDGET_MS = (parseFloat(opt("seconds", "570")) || 570) * 1000;
const LANES = Math.max(1, parseInt(opt("lanes", "3"), 10) || 3);
const RELAXED = args.includes("--relaxed"); // lower the cue floor (some specials only carry partial tracks)

const map = JSON.parse(readFileSync(new URL("./lm2-sp-map.json", import.meta.url), "utf8"));
const progress = existsSync(PROGRESS) ? JSON.parse(readFileSync(PROGRESS, "utf8")) : { done: {} };
const t0 = Date.now();
const left = () => BUDGET_MS - (Date.now() - t0);

function curl(url, hdrs = []) {
  return new Promise((res) => {
    const a = ["-sS", "--max-time", "25", "-A", UA, "--compressed", "-w", "\n__ST__%{http_code}", url];
    for (const h of hdrs) a.push("-H", h);
    execFile("curl", a, { maxBuffer: 32 * 1024 * 1024 }, (e, out) => {
      const m = out.match(/__ST__(\d+)\s*$/);
      res({ status: m ? +m[1] : 0, body: out.replace(/__ST__\d+\s*$/, "") });
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms * (0.7 + Math.random() * 0.6);

let session = null; // { hash, expires }
async function getSession() {
  if (session && Date.now() < session.freshUntil) return session;
  const page = await curl(SHOW_PLAY);
  const hash = page.body?.match(/hash:\s*'([^']+)'/)?.[1];
  const expires = page.body?.match(/expires:\s*(\d+)/)?.[1];
  if (!hash || !expires) return null;
  session = { hash, expires, freshUntil: Date.now() + 45 * 60_000 };
  return session;
}

async function accessEpisode(id) {
  const s = await getSession();
  if (!s) return null;
  const r = await curl(`${SITE}/api/v1/security/episode-access?id_episode=${id}&hash=${s.hash}&expires=${s.expires}`, [
    "Referer: " + SHOW_PLAY,
    "X-Requested-With: XMLHttpRequest",
  ]);
  if (r.status !== 200) return null;
  try { return JSON.parse(r.body); } catch { return null; }
}

async function accessMovie(slug) {
  const page = await curl(`${SITE}/movies/play/${slug}`);
  if (page.status !== 200) return null;
  const id = page.body.match(/id_movie:\s*["']?(\d+)/)?.[1];
  const hash = page.body.match(/hash:\s*["']([^"']+)["']/)?.[1];
  const expires = page.body.match(/expires:\s*["']?(\d+)/)?.[1];
  if (!id || !hash || !expires) return null;
  const r = await curl(`${SITE}/api/v1/security/movie-access?id_movie=${id}&hash=${hash}&expires=${expires}`, [
    "Referer: " + SITE + "/movies/play/" + slug,
    "X-Requested-With: XMLHttpRequest",
  ]);
  if (r.status !== 200) return null;
  try { return JSON.parse(r.body); } catch { return null; }
}

function countCues(vtt) {
  return (vtt.match(/-->/g) || []).length;
}
function lastCueSec(vtt) {
  const m = [...vtt.matchAll(/(\d{2,}):(\d{2}):(\d{2})/g)].pop();
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0;
}

/** Download every English candidate, keep the best (most cues, full coverage). */
async function bestEnglishVtt(payload, relaxed = false) {
  const minCues = relaxed ? 30 : 80;
  const cands = (payload?.subtitles ?? [])
    .map((s) => (typeof s?.file === "string" ? s : typeof s?.file === "object" && typeof s.file?.url === "string" ? { ...s, file: s.file.url } : s))
    .filter((s) => /english/i.test(s?.language ?? "") && typeof s?.file === "string" && s.file)
    .map((s) => (s.file.startsWith("http") ? s.file : SITE + s.file));
  let best = null;
  for (const url of cands.slice(0, 8)) {
    const r = await curl(url, ["Referer: " + SITE + "/"]);
    if (r.status !== 200 || !r.body.startsWith("WEBVTT")) continue;
    const cues = countCues(r.body);
    if (cues < minCues) continue; // partial/SDH-fragment tracks
    const score = cues * 10 + Math.min(lastCueSec(r.body), 1400);
    if (!best || score > best.score) best = { vtt: r.body, cues, score };
  }
  return best;
}

/** Build the full work list: [malId, ep, kind(ref)] — TV via episode map, bucket via movies. */
const work = [];
for (const [season, eps] of Object.entries(map.episodes)) {
  const malId = 999900 + Number(season);
  if (season === "0") {
    // LM2 S0E45 = the movie = our bucket ep3; bucket eps 1-2 = the movies.
    // The show-episode entry carries no subtitles (subs=0 verified) — merge
    // the movie slug's payload so BLU gets its English CC too.
    if (eps["45"] != null) work.push({ malId, ep: 3, kind: "episode", id: eps["45"], alsoSlug: map.movies["0/3"] });
    for (const [ep, slug] of Object.entries(map.movies)) {
      if (ep.startsWith("0/") && ep !== "0/3") work.push({ malId, ep: Number(ep.split("/")[1]), kind: "movie", slug });
    }
  } else {
    for (const [ep, id] of Object.entries(eps)) work.push({ malId, ep: Number(ep), kind: "episode", id });
  }
}
work.sort((a, b) => a.malId - b.malId || a.ep - b.ep);
const todo = work.filter((w) => !progress.done[`${w.malId}/${w.ep}`]);
console.log(`work: ${work.length} items, ${todo.length} to go, done: ${work.length - todo.length}`);

let ok = 0, fail = 0;
let cursor = 0;
async function lane() {
  while (cursor < todo.length && left() > 15_000) {
    const w = todo[cursor++];
    const key = `${w.malId}/${w.ep}`;
    try {
      let payload = w.kind === "episode" ? await accessEpisode(w.id) : await accessMovie(w.slug);
      if (w.alsoSlug) {
        const extra = await accessMovie(w.alsoSlug);
        if (extra?.subtitles?.length) {
          payload = { ...(payload ?? extra), subtitles: [...(payload?.subtitles ?? []), ...extra.subtitles] };
        }
      }
      if (!payload?.success && w.kind === "movie") throw new Error("movie access failed");
      let best = await bestEnglishVtt(payload, RELAXED);
      if (!best && !RELAXED) best = await bestEnglishVtt(payload, true); // retry relaxed before failing
      if (!best) throw new Error("no usable English VTT");
      await db.spCaption.upsert({
        where: { malId_ep: { malId: w.malId, ep: w.ep } },
        update: { content: best.vtt, cues: best.cues, checkedAt: new Date() },
        create: { malId: w.malId, ep: w.ep, content: best.vtt, cues: best.cues },
      });
      progress.done[key] = { cues: best.cues, at: new Date().toISOString() };
      ok++;
      if (ok % 10 === 0) { writeFileSync(PROGRESS, JSON.stringify(progress)); console.log(`  +${ok} (${key}, ${best.cues} cues, ${((Date.now() - t0) / 1000).toFixed(0)}s)`); }
    } catch (e) {
      progress.done[key] = { fail: String(e).slice(0, 120), at: new Date().toISOString() };
      fail++;
      console.log(`  FAIL ${key}: ${String(e).slice(0, 90)}`);
    }
    writeFileSync(PROGRESS, JSON.stringify(progress));
    await sleep(jitter(400));
  }
}
await Promise.all(Array.from({ length: LANES }, () => lane()));

writeFileSync(PROGRESS, JSON.stringify(progress));
const total = work.length;
const done = Object.keys(progress.done).length;
console.log(`\nharvest run: ok=${ok} fail=${fail} | progress: ${done}/${total}`);
if (done >= total) console.log("ALL DONE");
await db.$disconnect();
