/**
 * Seed official title logos (fanart.tv-style clearlogos) into Anime.logoUrl.
 *
 * fanart.tv itself is unreachable + key-gated from this environment, so we
 * source the SAME class of artwork (official transparent clearlogos) through
 * the in-house image-search service, which re-hosts every hit on OSS (stable,
 * hotlinkable, exactly how sync.ts ART_OVERRIDES banners already work).
 *
 * Validation keeps only real logos: PNG with an alpha channel, wide-ish,
 * reasonably sized. Everything else (posters, JPEGs, squares) is rejected.
 *
 * Resume-safe: rows with a logoUrl are skipped (pass --force to redo).
 *
 * Usage:
 *   node scripts/seed-fanart-logos.mjs            # all missing, 5 workers
 *   node scripts/seed-fanart-logos.mjs --force    # redo every catalog row
 *   node scripts/seed-fanart-logos.mjs 5114 21    # just these malIds
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";

const run = promisify(execFile);
const db = new PrismaClient();
const TMP = "scripts/.logo-seed-tmp";
const REPORT = "scripts/seed-fanart-logos-report.json";

const WORKERS = 1; // the search gateway rate-limits hard — sequential only
const WALL_CAP_MS = 60 * 60 * 1000; // stop cleanly after 60 min; rerun to resume
const startedAt = Date.now();

function parseIHDR(buf) {
  // PNG: 8-byte sig, then len(4) "IHDR" width(4) height(4) ... colorType at [25]
  if (buf.length < 26 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    colorType: buf[25], // 6 = RGBA, 4 = gray+alpha, 3 = palette (may carry tRNS)
  };
}

/** Palette PNGs are transparent only when a tRNS chunk exists before IDAT. */
function hasTrns(buf) {
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    if (type === "tRNS") return true;
    if (type === "IDAT") return false;
    off += 12 + len;
  }
  return false;
}

function pngInfo(buf) {
  const ihdr = parseIHDR(buf);
  if (!ihdr) return null;
  const alpha = ihdr.colorType === 6 || ihdr.colorType === 4 || (ihdr.colorType === 3 && hasTrns(buf));
  return { ...ihdr, alpha, aspect: ihdr.width / ihdr.height };
}

/** Real logo? Transparent PNG (real alpha, incl. palette+tRNS) or SVG. */
async function inspectLogo(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const size = Number(res.headers.get("content-length") ?? 0);
    if (size > 4_000_000) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const head = buf.subarray(0, 400).toString("ascii").toLowerCase();
    if (head.includes("<svg")) {
      // vector logos are always crisp + transparent; assume wordmark-ish width
      return { width: 1000, height: 400, alpha: true, aspect: 2.5 };
    }
    const info = pngInfo(buf);
    if (!info || !info.alpha) return null;
    if (info.width < 300 || info.height < 80) return null;
    if (info.aspect < 0.85 || info.aspect > 8) return null; // allow square marks
    return info;
  } catch {
    return null;
  }
}

/** Significant title tokens for caption matching (drop filler words). */
const STOP = new Set(["the", "a", "an", "of", "no", "ke", "wa", "ga", "and", "in", "to", "x", "part", "season", "tv", "special", "ova", "ona", "movie", "film", "edition", "collection", "complete", "final", "new", "ii", "iii", "iv", "2", "3", "4", "5"]);
function titleTokens(name) {
  const toks = name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const sig = toks.filter((t) => !STOP.has(t) && t.length > 1);
  // prefer distinctive words: brand-ish words first (they survive captions best)
  return sig.length > 2 ? sig.slice(0, 2) : sig;
}

/** Caption must actually talk about THIS show — geometry alone let a metal
 *  band's "Brutal Deluxe" logo slip through as the One Piece mark. */
function captionMatches(caption, tokens) {
  const c = (caption ?? "").toLowerCase();
  if (!c) return false;
  if (tokens.length === 0) return /logo|wordmark|title/.test(c);
  return tokens.every((t) => c.includes(t));
}

async function searchImages(query, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      // captions ON: they are our semantic filter (the CLI prints JSON to stdout)
      const { stdout } = await run("z-ai", ["image-search", "-q", query, "-c", "10", "--gl", "us"], {
        timeout: 170_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const start = stdout.indexOf("{");
      if (start < 0) return [];
      const j = JSON.parse(stdout.slice(start));
      return j.success ? j.results ?? [] : [];
    } catch (e) {
      const msg = String(e.message);
      if (msg.includes("429") && i < tries) {
        // throttle window is long — one patient wait, then give the title up
        console.log(`    429, backing off 150s (${i}/${tries - 1})`);
        await new Promise((r) => setTimeout(r, 150_000));
        continue;
      }
      console.log(`    search fail: ${msg.slice(0, 90)}`);
      return [];
    }
  }
  return [];
}

// Query forms, tried one per pass over the still-missing titles. Search
// results shuffle per call, so different phrasings land different assets.
const FORMS = [
  (n) => `${n} anime clearlogo transparent png`,
  (n) => `${n} logo png transparent background`,
  (n) => `${n} anime title logo png`,
];
const formIdx = Math.max(0, FORMS.findIndex((_, i) => process.argv.includes(`--form${i + 1}`)));

async function logoFor(row) {
  const name = (row.titleEnglish?.trim() || row.title).replace(/\s+/g, " ").trim();
  const tokens = titleTokens(name);
  // ONE query per title — the gateway's throttle budget can't afford more.
  const results = await searchImages(FORMS[formIdx](name));
  const valid = [];
  for (const r of results) {
    const url = r.original_url;
    if (!url) continue;
    if (!captionMatches(r.caption, tokens)) continue;
    const info = await inspectLogo(url);
    if (info) valid.push({ url, aspect: info.aspect });
  }
  if (!valid.length) return null;
  valid.sort((a, b) => b.aspect - a.aspect);
  return { url: valid[0].url, aspect: valid[0].aspect.toFixed(2), query: `form${formIdx + 1}` };
}

async function worker(queue, force, report) {
  for (;;) {
    const row = queue.shift();
    if (!row) return;
    if (Date.now() - startedAt > WALL_CAP_MS) return;
    try {
      const found = await logoFor(row);
      if (found) {
        await db.anime.update({ where: { malId: row.malId }, data: { logoUrl: found.url } });
        report.ok.push({ malId: row.malId, title: row.title, url: found.url });
        console.log(`OK  ${row.malId} ${row.titleEnglish || row.title}  (${(found.query.match(/clearlogo|logo/) || [""])[0]})`);
      } else {
        report.miss.push({ malId: row.malId, title: row.titleEnglish || row.title });
        console.log(`MISS ${row.malId} ${row.titleEnglish || row.title}`);
      }
    } catch (e) {
      report.fail.push({ malId: row.malId, error: String(e.message).slice(0, 120) });
      console.log(`ERR ${row.malId}: ${String(e.message).slice(0, 90)}`);
    }
    await writeFile(REPORT, JSON.stringify(report, null, 1)).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 4_000)); // gentle pacing between titles
  }
}

const args = process.argv.slice(2);
const force = args.includes("--force");
const ids = args.filter((a) => /^\d+$/.test(a)).map(Number);

await mkdir(TMP, { recursive: true });
const where = ids.length
  ? { malId: { in: ids } }
  : { inCatalog: true, ...(force ? {} : { logoUrl: null }) };
let rows = await db.anime.findMany({ where, select: { malId: true, title: true, titleEnglish: true } });

// Visible titles first: whatever the home rails currently show gets covered
// before the long tail, so even a partial run upgrades the whole front page.
if (!ids.length) {
  try {
    const res = await fetch("http://localhost:3000/api/home");
    if (res.ok) {
      const home = await res.json();
      const order = [];
      for (const it of home.hero ?? []) order.push(it.malId);
      for (const s of home.sections ?? []) for (const it of s.items ?? []) order.push(it.malId);
      const rank = new Map();
      for (const id of order) if (!rank.has(id)) rank.set(id, rank.size);
      rows.sort((a, b) => (rank.get(a.malId) ?? 9999) - (rank.get(b.malId) ?? 9999));
    }
  } catch {
    /* dev server down — catalog order is fine */
  }
}
console.log(`Seeding logos for ${rows.length} titles (${WORKERS} workers, cap ${WALL_CAP_MS / 60000}min)`);

const report = { ok: [], miss: [], fail: [] };
const queue = [...rows];
await Promise.all(Array.from({ length: WORKERS }, () => worker(queue, force, report)));
await writeFile(REPORT, JSON.stringify(report, null, 1));

const set = await db.anime.count({ where: { inCatalog: true, NOT: { logoUrl: null } } });
const total = await db.anime.count({ where: { inCatalog: true } });
console.log(`\nDone. ok=${report.ok.length} miss=${report.miss.length} fail=${report.fail.length}`);
console.log(`Catalog logos: ${set}/${total}`);
await db.$disconnect();
