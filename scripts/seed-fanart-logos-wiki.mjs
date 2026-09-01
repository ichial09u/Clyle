/**
 * Seed official title logos into Anime.logoUrl from Wikipedia / Wikimedia
 * Commons, stored as LOCAL static assets (public/logos/<malId>.png).
 *
 * Why local files: wikimedia thumburls work, but half the official wordmarks
 * are pure black — invisible on our dark posters. We rasterize each logo,
 * measure it, recolor dark ink to Netflix-style white (keeping the original
 * alpha), and commit the PNG so Vercel serves it from its CDN.
 *
 * Per title:
 *   1. File-namespace search on en.wikipedia + commons for "<name> logo"
 *   2. Score: WORD-BOUNDARY franchise match (substring let "Bleach" win
 *      "Bleacher Report"), clean "logo.(png|svg)" shape, enwiki over commons,
 *      penalties for localized variants and game/movie/tour tie-ins
 *   3. Download original, rasterize SVGs to 640px
 *   4. Validate: wide-ish, really transparent, light enough on white —
 *      dark ink gets recolored to white instead of rejected
 *
 * Resume-safe: rows with a logoUrl are skipped (pass --force to redo).
 *
 * Usage:
 *   node scripts/seed-fanart-logos-wiki.mjs            # all missing
 *   node scripts/seed-fanart-logos-wiki.mjs --force    # redo every row
 *   node scripts/seed-fanart-logos-wiki.mjs 5114 21    # just these malIds
 */

import { mkdir, writeFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import sharp from "sharp";

const db = new PrismaClient();
const UA = "Clyle/1.0 (anime web app; https://zokoanime.video; contact: dev@zokoanime.video)";
const OUT_DIR = "public/logos";
const WIKIS = {
  en: "https://en.wikipedia.org/w/api.php",
  commons: "https://commons.wikimedia.org/w/api.php",
};

const STOP = new Set([
  "the", "a", "an", "of", "no", "ke", "wa", "ga", "and", "in", "to", "x",
  "part", "season", "tv", "special", "ova", "ona", "movie", "film", "edition",
  "collection", "complete", "final", "new", "ii", "iii", "iv", "2", "3", "4", "5",
]);

function titleTokens(name) {
  const toks = name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const sig = [...new Set(toks.filter((t) => !STOP.has(t) && t.length > 1))];
  return sig.length > 2 ? sig.slice(0, 2) : sig;
}

async function apiGet(wiki, params) {
  const url = `${WIKIS[wiki]}?${new URLSearchParams({ format: "json", ...params })}`;
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
      if (res.ok) return await res.json();
      if (res.status === 429) await new Promise((r) => setTimeout(r, 2_000 * i));
      else return null;
    } catch {
      await new Promise((r) => setTimeout(r, 1_000 * i));
    }
  }
  return null;
}

async function searchFiles(wiki, name) {
  const j = await apiGet(wiki, {
    action: "query",
    list: "search",
    srnamespace: "6",
    srlimit: "10",
    srsearch: `${name} logo`,
  });
  return (j?.query?.search ?? []).map((r) => r.title);
}

async function huntCandidates(name, tokens) {
  const [en, commons] = await Promise.all([searchFiles("en", name), searchFiles("commons", name)]);
  return [
    ...en.map((t) => ({ t, wiki: "en" })),
    ...commons.map((t) => ({ t, wiki: "commons" })),
  ]
    .map((c) => ({ ...c, s: scoreFile(c.t, tokens, c.wiki) }))
    .filter((c) => c.s > -Infinity)
    .sort((a, b) => b.s - a.s)
    .slice(0, 6);
}

const LOCALIZED = /(interna[cz]ional|\bkr\b|\bkor\b|\bita\b|\bar\b|\bes\b|\bde\b|\bfr\b|\bpt\b|\bru\b|vietnam|china|jpn|black background|dark|animated|alt|variant)/i;
// games, movies, events, merchandise — never the show's own wordmark
const TIE_IN = /(revolution|\bgame\b|\bps[1-5]\b|switch|xbox|\bcard(s)?\b|fight|puzzle|concert|tower|musical|stage|cafe|collab|album|soundtrack|\bdvd\b|\bblu(\s|-)?ray\b|\bfilm\b|code white|movie \d|\d(?:st|nd|rd|th) (?:movie|op|ed)|attach)/i;

// fold diacritics (Shippūden -> shippuden) and split camelCase
// (GintamaAnimeLogo -> "gintama anime logo", MadeInAbyss -> "made in abyss")
function normName(s) {
  return fold(s.replace(/([a-z])([A-Z])/g, "$1 $2"))
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function fold(s) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function scoreFile(fileTitle, tokens, wiki) {
  const words = normName(fileTitle).split(" ");
  if (words[0] !== "file" || words.length < 3) return -Infinity;
  // franchise tokens must appear (word-start tolerance lets HAIKYU match
  // Haikyuu) AND in title order ("the last witch hunter" can't satisfy
  // [hunter, last])
  let p = 1;
  for (const t of tokens) {
    let found = false;
    for (; p < words.length; p++) {
      if (words[p].startsWith(t)) {
        found = true;
        break;
      }
    }
    if (!found) return -Infinity;
    p++;
  }
  if (!words.some((w) => w === "logo" || w === "wordmark")) return -Infinity;
  const f = words.join(" ");
  if (/\.(gif|jpg|jpeg|webp|tiff)$/.test(f)) return -Infinity; // raster transparency unreliable
  if (TIE_IN.test(f)) return -Infinity;
  let s = 0;
  if (/^file [a-z0-9 ]+ logo (png|svg)$/.test(f)) s += 5; // canonical clean shape
  if (/svg$/.test(f)) s += 3; // vector = always crisp + truly transparent
  else if (/png$/.test(f)) s += 2;
  if (wiki === "en") s += 2; // the article's own artwork
  if (LOCALIZED.test(f)) s -= 4;
  if (tokens.length && words[1]?.startsWith(tokens[0])) s += 1; // leads with the franchise name
  return s;
}

async function originalUrlFor(wiki, fileTitle) {
  const j = await apiGet(wiki, {
    action: "query",
    titles: fileTitle,
    prop: "imageinfo",
    iiprop: "url|size|mime",
  });
  const page = Object.values(j?.query?.pages ?? {})[0];
  const info = page?.imageinfo?.[0];
  if (!info) return null;
  if (!/image\/(svg\+xml|png)/.test(info.mime ?? "")) return null;
  if ((info.width ?? 0) && (info.width < 260 || info.height < 60)) return null;
  return { url: info.url, mime: info.mime, w: info.width, h: info.height };
}

/**
 * Rasterize (SVG at high density) to ≤640px RGBA raw pixels, then measure:
 *  - transparentShare: fraction of pixels with alpha<128 (must really be a cutout)
 *  - meanOnWhite: perceived ink brightness with transparent read as white —
 *    near-black wordmarks score very low and get recolored to white ink
 */
async function rasterize(buf, mime, width) {
  let img;
  if ((mime ?? "").includes("svg")) {
    const density = Math.min(600, Math.max(96, Math.round((72 * 640) / Math.max(1, width || 400))));
    img = sharp(buf, { density }).resize({ width: 640, height: 640, fit: "inside" });
  } else {
    img = sharp(buf).resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true });
  }
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) return null;
  const n = info.width * info.height;
  let transparent = 0;
  let sumOnWhite = 0;
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3];
    if (a < 128) {
      transparent++;
      sumOnWhite += 255;
    } else {
      // Rec.601 luma of the ink
      sumOnWhite += 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    }
  }
  return {
    data,
    info,
    transparentShare: transparent / n,
    meanOnWhite: sumOnWhite / n,
  };
}

async function processTitle(row) {
  const name = (row.titleEnglish?.trim() || row.title).replace(/\s+/g, " ").trim();
  const tokens = titleTokens(name);
  // full name first; if the specific title (seasons, "(2011)", colons) finds
  // nothing, fall back to the bare franchise words — the filename scoring
  // still enforces the franchise tokens on every candidate
  let candidates = await huntCandidates(name, tokens);
  if (!candidates.length && tokens.length >= 2) candidates = await huntCandidates(tokens.join(" "), tokens);
  if (!candidates.length && tokens.length >= 1) candidates = await huntCandidates(tokens[0], tokens);

  for (const c of candidates) {
    const info = await originalUrlFor(c.wiki, c.t);
    if (!info) continue;
    try {
      const res = await fetch(info.url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 8_000_000) continue;
      const r = await rasterize(buf, info.mime, info.w);
      if (!r) continue;
      if (r.info.width < 260 || r.info.height < 60) continue;
      const aspect = r.info.width / r.info.height;
      if (aspect < 0.85 || aspect > 8) {
        console.log(`    skip ${c.t.replace(/^File:/, "")} — aspect ${aspect.toFixed(2)}`);
        continue;
      }
      if (r.transparentShare < 0.04) {
        console.log(`    skip ${c.t.replace(/^File:/, "")} — opaque box`);
        continue;
      }
      const recolor = r.meanOnWhite < 60;
      if (recolor) {
        // keep the shape, turn the ink pure white (readable on dark posters)
        for (let i = 0; i < r.data.length; i += 4) {
          if (r.data[i + 3] > 0) {
            r.data[i] = 255;
            r.data[i + 1] = 255;
            r.data[i + 2] = 255;
          }
        }
      }
      const png = await sharp(r.data, { raw: { width: r.info.width, height: r.info.height, channels: 4 } })
        .png({ compressionLevel: 9 })
        .toBuffer();
      await mkdir(OUT_DIR, { recursive: true });
      await writeFile(`${OUT_DIR}/${row.malId}.png`, png);
      const url = `/logos/${row.malId}.png`;
      await db.anime.update({ where: { malId: row.malId }, data: { logoUrl: url } });
      console.log(
        `OK  ${row.malId} ${name} -> ${c.t.replace(/^File:/, "")}${recolor ? " [recolored white]" : ""} (${Math.round(png.length / 1024)}KB)`,
      );
      return true;
    } catch (e) {
      console.log(`    fail ${c.t.replace(/^File:/, "")} — ${String(e.message).slice(0, 60)}`);
    }
  }
  console.log(`MISS ${row.malId} ${name} (${candidates.length} candidates)`);
  return false;
}

const args = process.argv.slice(2);
const force = args.includes("--force");
const ids = args.filter((a) => /^\d+$/.test(a)).map(Number);

const where = ids.length
  ? { malId: { in: ids }, ...(force ? {} : { logoUrl: null }) } // never clobber existing artwork
  : { inCatalog: true, ...(force ? {} : { logoUrl: null }) };
const rows = await db.anime.findMany({ where, select: { malId: true, title: true, titleEnglish: true } });
console.log(`Wiki-seeding logos for ${rows.length} titles -> ${OUT_DIR}/`);

const report = { ok: [], miss: [], fail: [] };
for (const row of rows) {
  try {
    const done = await processTitle(row);
    if (done) report.ok.push({ malId: row.malId, title: row.titleEnglish || row.title });
    else report.miss.push({ malId: row.malId, title: row.titleEnglish || row.title });
  } catch (e) {
    console.log(`ERR ${row.malId}: ${String(e.message).slice(0, 100)}`);
    report.fail.push({ malId: row.malId, error: String(e.message).slice(0, 120) });
  }
  await new Promise((r) => setTimeout(r, 350)); // be polite to the WMF APIs
}

await writeFile("scripts/seed-fanart-logos-wiki-report.json", JSON.stringify(report, null, 1)).catch(() => undefined);

const set = await db.anime.count({ where: { inCatalog: true, NOT: { logoUrl: null } } });
const total = await db.anime.count({ where: { inCatalog: true } });
console.log(`\nDone. ok=${report.ok.length} miss=${report.miss.length} fail=${report.fail.length}`);
console.log(`Catalog logos: ${set}/${total}`);
await db.$disconnect();
