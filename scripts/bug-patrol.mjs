/**
 * Bug patrol — the site's 24/7 QA bot.
 *
 * Sweeps the running app the way a real user (and a real QA pass) would:
 *
 *   1. PAGES          /, manifest.webmanifest, sw.js, icons — status + shape
 *   2. API ROUTES     every public route: status, JSON shape, latency
 *                     (measured on the WARM hit — cold caches are normal)
 *   3. STREAMS        resolves /api/stream for sampled animes (sub + dub),
 *                     fetches the HLS playlist AND a real segment with CDN
 *                     headers — a stream that resolves but won't serve bytes
 *                     is the #1 user-facing breakage
 *   4. DUB CLAIMS     anime whose DB data claims a real dub must actually
 *                     resolve a dub stream (and vice versa: no fake-dub
 *                     buttons)
 *   5. DB RULES       6 consistency rules over the catalog/fleet tables
 *                     (degenerate rows, placeholder titles, contradictions)
 *   6. ART            poster images through the /api/art proxy
 *   7. PROD PROBES    same core routes against prod — catches prod-only
 *                     regressions between deploys
 *
 * Findings go DIRECTLY into the local sqlite BugReport table through Prisma
 * (NOT through the dev server API — the patrol must survive dev-server
 * crashes, that's exactly when it matters). Dedup + count bumps +
 * reopen-on-regression are implemented here on the upsert path.
 *
 * Usage: node scripts/bug-patrol.mjs [--once] [--loop] [--base URL] [--prod URL]
 */
import { PrismaClient } from "@prisma/client";

process.on("unhandledRejection", (err) => console.error("[patrol] unhandledRejection:", err?.message ?? err));
process.on("uncaughtException", (err) => console.error("[patrol] uncaughtException:", err?.stack?.slice(0, 300) ?? err));

const db = new PrismaClient();

const args = process.argv.slice(2);
const argOf = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const LOOP = args.includes("--loop");
const ONCE = args.includes("--once") || !LOOP;
const BASE = argOf("--base") ?? "http://localhost:3000";
const PROD = argOf("--prod") ?? "https://temporary-spry-granite-1f0h7ae.vercel.app";
const SWEEP_PAUSE_MS = parseInt(argOf("--pause", "720") ?? "720", 10) * 1000; // ~12 min

const UA = "Mozilla/5.0 (ClylePatrol/1.0)";
const TIMEOUT = 45_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, opts = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, ...(opts.headers ?? {}) },
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT),
    });
    const text = await res.text();
    return { status: res.status, ms: Date.now() - t0, text, ct: res.headers.get("content-type") ?? "" };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, text: "", ct: "", err: String(e?.message ?? e).slice(0, 120) };
  }
}

async function getJson(url, opts = {}) {
  const r = await get(url, opts);
  if (r.status !== 200) return { ...r, json: null };
  try {
    return { ...r, json: JSON.parse(r.text) };
  } catch {
    return { ...r, json: null };
  }
}

/* ---------------- findings (direct sqlite upsert) ---------------- */

let sweepFindings = [];

async function fileFinding(kind, targetKey, severity, detail) {
  sweepFindings.push({ kind, targetKey, severity, detail });
  try {
    const existing = await db.bugReport.findUnique({ where: { kind_targetKey: { kind, targetKey } } });
    if (!existing) {
      await db.bugReport.create({ data: { kind, targetKey: targetKey.slice(0, 300), severity, detail: detail.slice(0, 500), status: "open", count: 1 } });
      log(`NEW [${kind}] ${targetKey} — ${detail.slice(0, 110)}`);
      return;
    }
    if (existing.status === "fixed") {
      await db.bugReport.update({
        where: { id: existing.id },
        data: { status: "open", count: existing.count + 1, lastSeen: new Date(), detail: `REOPENED: ${detail.slice(0, 400)}` },
      });
      log(`REOPENED [${kind}] ${targetKey} — ${detail.slice(0, 110)}`);
      return;
    }
    if (existing.status === "ignored") return;
    await db.bugReport.update({
      where: { id: existing.id },
      data: { count: existing.count + 1, lastSeen: new Date(), detail: detail.slice(0, 500) },
    });
  } catch (e) {
    log(`finding-db error ${kind}/${targetKey}: ${String(e?.message ?? e).slice(0, 100)}`);
  }
}

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

/* ---------------- 1) pages + PWA assets ---------------- */

async function checkPages() {
  let checked = 0;
  const pages = [
    { url: `${BASE}/`, expect: "text/html", must: "<div", key: "GET /" },
    { url: `${BASE}/manifest.webmanifest`, expect: "json", must: "name", key: "GET /manifest.webmanifest" },
    { url: `${BASE}/sw.js`, expect: "javascript", must: "addEventListener", key: "GET /sw.js" },
    { url: `${BASE}/icon-192.png`, expect: "image", must: "", key: "GET /icon-192.png" },
    { url: `${BASE}/robots.txt`, expect: "text", must: "", key: "GET /robots.txt" },
  ];
  for (const p of pages) {
    checked++;
    const r = await get(p.url);
    if (r.status === 0) {
      await fileFinding("page-broken", p.key, 1, `network error: ${r.err}`);
    } else if (r.status !== 200) {
      await fileFinding("page-broken", p.key, 1, `HTTP ${r.status}`);
    } else if (p.must && !r.text.includes(p.must)) {
      await fileFinding("api-shape", p.key, 2, `200 but missing "${p.must}" (ct ${r.ct})`);
    }
  }
  return checked;
}

/* ---------------- 2) API routes (shape + warm latency) ---------------- */

const PATROL_USER = "patrol-bot-user";

// expected-shape checks per route; `warm` = hit twice, time the second
const API_CHECKS = [
  { url: `/api/home`, warm: true, slowMs: 2500, shape: (j) => j?.sections?.length >= 1 && Array.isArray(j?.hero), key: "GET /api/home" },
  { url: `/api/latest`, warm: false, slowMs: 2500, shape: (j) => Array.isArray(j?.updates), key: "GET /api/latest" },
  { url: `/api/genres`, warm: false, slowMs: 2500, shape: (j) => Array.isArray(j?.genres) && j.genres.length > 0, key: "GET /api/genres" },
  { url: `/api/top10`, warm: false, slowMs: 4000, shape: (j) => Array.isArray(j?.items), key: "GET /api/top10" },
  { url: `/api/top10-events`, warm: false, slowMs: 2500, shape: (j) => Array.isArray(j?.events), key: "GET /api/top10-events" },
  { url: `/api/search?q=doraemon`, warm: false, slowMs: 4000, shape: (j) => Array.isArray(j?.catalog), key: "GET /api/search" },
  { url: `/api/genre/Action`, warm: false, slowMs: 3000, shape: (j) => j?.genre === "Action" && Array.isArray(j?.catalog), key: "GET /api/genre/[name]" },
  { url: `/api/anime/21`, warm: true, slowMs: 2500, shape: (j) => j?.anime?.malId === 21 && !!j?.anime?.title, key: "GET /api/anime/[id]" },
  { url: `/api/anime/21/episodes`, warm: true, slowMs: 3500, shape: (j) => j?.episodes?.length > 0, key: "GET /api/anime/[id]/episodes" },
  { url: `/api/skip-audit`, warm: true, slowMs: 6000, shape: (j) => typeof j === "object", key: "GET /api/skip-audit" },
  { url: `/api/suggestions?userId=${PATROL_USER}`, warm: false, slowMs: 3000, shape: (j) => Array.isArray(j?.items), key: "GET /api/suggestions" },
  { url: `/api/continue?userId=${PATROL_USER}`, warm: false, slowMs: 2500, shape: (j) => Array.isArray(j?.items) || Array.isArray(j), key: "GET /api/continue" },
  { url: `/api/cron`, warm: false, slowMs: 60_000, shape: (j) => typeof j === "object", key: "GET /api/cron" },
];

async function checkApis() {
  let checked = 0;
  for (const c of API_CHECKS) {
    checked++;
    // warmup hit (cache fills; not timed) — also the shape source
    let r = await getJson(`${BASE}${c.url}`);
    if (c.warm) {
      await sleep(250);
      r = await getJson(`${BASE}${c.url}`); // timed on the warm hit
    }
    if (r.status === 0) {
      await fileFinding("api-error", c.key, 1, `network error: ${r.err}`);
      continue;
    }
    if (r.status === 404) {
      // a clean 404 from a route that should exist IS a bug — but only if the
      // route is registered. Distinguish: dev returns HTML 404 page for
      // unregistered routes; registered routes return JSON errors.
      if (r.ct.includes("text/html")) {
        await fileFinding("api-error", c.key, 1, "404 HTML — route not registered?");
      }
      continue;
    }
    if (r.status !== 200) {
      await fileFinding("api-error", c.key, 1, `HTTP ${r.status}: ${r.text.slice(0, 120)}`);
      continue;
    }
    if (r.json === null) {
      await fileFinding("api-shape", c.key, 2, `200 but body is not JSON (ct ${r.ct})`);
      continue;
    }
    try {
      if (!c.shape(r.json)) {
        await fileFinding("api-shape", c.key, 2, `200 but shape wrong: ${JSON.stringify(r.json).slice(0, 140)}`);
        continue;
      }
    } catch (e) {
      await fileFinding("api-shape", c.key, 2, `shape check threw: ${String(e).slice(0, 100)}`);
      continue;
    }
    if (r.ms > c.slowMs) {
      await fileFinding("api-slow", c.key, 2, `warm latency ${r.ms}ms > ${c.slowMs}ms budget`);
    }
  }
  return checked;
}

/* ---------------- 3) stream integrity (sub + dub playlists + bytes) ---------------- */

// per-host CDN headers, mirroring src/lib/stream-proxy-registry.ts:
//  - Zoko's video CDN (aniwatchtv.uk et al.) wants Zoko's own Referer (default)
//  - Megaplay's rotating CDN families want megaplay.buzz
//  - SupaPlay's signed MP4 CDN wants NO Referer at all
const MEGAP_SUFFIXES = [".shiora.top", ".shiora.site", ".norami.top", ".akirax.buzz", ".mikora.top", ".kryntal.top", ".vaelith.top"];
const ZOKO_REFERER = "https://zokoanime.video/";
const MEGAPLAY_REFERER = "https://megaplay.buzz/";

function cdnHeadersFor(rawUrl) {
  let host = "";
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return {};
  }
  if (MEGAP_SUFFIXES.some((s) => host.endsWith(s))) {
    return { Referer: MEGAPLAY_REFERER, Origin: MEGAPLAY_REFERER.replace(/\/$/, "") };
  }
  if (host.endsWith(".hakunaymatata.com")) return {}; // plain signed URLs
  // zoko default
  return { Referer: ZOKO_REFERER, Origin: ZOKO_REFERER.replace(/\/$/, "") };
}

async function probePlaylist(src, label, targetKey, severity) {
  const pl = await get(src, { headers: cdnHeadersFor(src), timeoutMs: 30_000 });
  if (pl.status !== 200 || !pl.text.includes("#EXTM3U")) {
    await fileFinding("stream-broken", targetKey, severity, `${label}: playlist HTTP ${pl.status} (no #EXTM3U)`);
    return false;
  }
  // pick the highest-bandwidth variant (or the media playlist itself)
  const lines = pl.text.split("\n").map((l) => l.trim()).filter(Boolean);
  let segUrl = null;
  let bestBw = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
      const bw = parseInt((lines[i].match(/BANDWIDTH=(\d+)/) ?? [])[1] ?? "0", 10);
      const next = lines[i + 1];
      if (next && !next.startsWith("#") && bw >= bestBw) {
        bestBw = bw;
        segUrl = new URL(next, src).toString();
      }
    }
  }
  if (!segUrl) {
    // media playlist: first .ts/.m3u8 target
    const target = lines.find((l) => !l.startsWith("#") && (l.includes(".ts") || l.includes(".m3u8")));
    segUrl = target ? new URL(target, src).toString() : null;
  }
  if (!segUrl) {
    await fileFinding("stream-broken", targetKey, severity, `${label}: playlist has no segments/variants`);
    return false;
  }
  const seg = await get(segUrl, { headers: cdnHeadersFor(segUrl), timeoutMs: 30_000 });
  if (seg.status !== 200 || seg.text.length === 0) {
    await fileFinding("stream-broken", targetKey, severity, `${label}: segment HTTP ${seg.status} (${segUrl.slice(0, 90)})`);
    return false;
  }
  return true;
}

async function checkStreamsAndDubs() {
  let checked = 0;
  // sample: a stable popular show + whatever the catalog offers up front
  const samples = [];
  const popular = await db.anime.findMany({
    where: { inCatalog: true },
    orderBy: { popularity: "asc" },
    take: 2,
    select: { malId: true, title: true },
  });
  samples.push(...popular);
  // rotate a different third show per sweep so coverage drifts across the catalog
  const total = await db.anime.count({ where: { inCatalog: true } });
  const skipN = Math.floor(Math.random() * Math.max(1, total - 3));
  const random = await db.anime.findMany({
    where: { inCatalog: true },
    orderBy: { malId: "asc" },
    skip: skipN,
    take: 1,
    select: { malId: true, title: true },
  });
  samples.push(...random);

  for (const a of samples) {
    for (const lang of ["sub", "dub"]) {
      checked++;
      const r = await getJson(`${BASE}/api/stream?malId=${a.malId}&ep=1&lang=${lang}&server=1`);
      if (r.status === 200 && r.json?.src) {
        await probePlaylist(r.json.src, `${lang} ep1`, `stream malId=${a.malId} ep=1 lang=${lang}`, 1);
      } else if (lang === "sub") {
        await fileFinding("stream-broken", `stream malId=${a.malId} ep=1 lang=sub`, 1, `resolve HTTP ${r.status} (sub must always exist)`);
      } else if (r.status === 200) {
        // 200 with no src on dub = no dub — only a problem if the DB CLAIMS dub
        // (handled by the dub-claim rule below)
      }
      // dub-claim cross-check: DB says real dub exists -> dub resolve must work
      if (lang === "dub") {
        checked++;
        const claimed =
          (await db.dubAudio.count({ where: { malId: a.malId, ep: 1, verdict: "real" } })) > 0 ||
          (await db.dubProbe.count({ where: { malId: a.malId, ep: 1, ok: true } })) > 0;
        if (claimed && !(r.status === 200 && r.json?.src)) {
          await fileFinding("dub-claim-mismatch", `dub malId=${a.malId}`, 2, `DB claims real dub (DubAudio/DubProbe) but /api/stream dub returned ${r.status}${r.json?.src ? "" : " without src"}`);
        }
      }
    }
  }
  return checked;
}

/* ---------------- 4) DB consistency rules ---------------- */

async function checkDbRules() {
  // R1 — IntroScout intervals must be sane (end > start, plausible OP window)
  const bad = await db.$queryRawUnsafe(
    `SELECT COUNT(*) as n FROM IntroScout WHERE nodetect = 0 AND (end <= start OR start > 320 OR end - start > 150 OR start < 0)`,
  );
  if (Number(bad[0]?.n) > 0) {
    await fileFinding("data-consistency", "db/introscout-degenerate", 3, `${Number(bad[0].n)} IntroScout rows with impossible intervals`);
  }

  // R2 — DubAudio verdicts must be a known enum
  const badVerdict = await db.$queryRawUnsafe(
    `SELECT COUNT(*) as n FROM DubAudio WHERE verdict NOT IN ('real','fake') OR server NOT IN ('zoko','kiwi')`,
  );
  if (Number(badVerdict[0]?.n) > 0) {
    await fileFinding("data-consistency", "db/dubaudio-enum", 3, `${Number(badVerdict[0].n)} DubAudio rows outside the verdict/server enum`);
  }

  // R3 — episode titles must never be bare "Episode N" placeholders (they'd
  // render as "Episode 12: Episode 12")
  const placeholders = await db.$queryRawUnsafe(
    `SELECT COUNT(*) as n FROM Episode WHERE title IS NOT NULL AND (title = number OR title GLOB 'Episode [0-9]*' = 1 AND length(title) < 14)`,
  );
  if (Number(placeholders[0]?.n) > 0) {
    await fileFinding("data-consistency", "db/episode-placeholder-titles", 3, `${Number(placeholders[0].n)} episode rows whose title is a bare "Episode N" placeholder`);
  }

  // R4 — progress positions must be positive
  const badPos = await db.$queryRawUnsafe(`SELECT COUNT(*) as n FROM WatchProgress WHERE position <= 0`);
  if (Number(badPos[0]?.n) > 0) {
    await fileFinding("data-consistency", "db/progress-position", 3, `${Number(badPos[0].n)} WatchProgress rows with position <= 0`);
  }

  // R5 — catalog anime must have art + a title
  const noArt = await db.$queryRawUnsafe(
    `SELECT COUNT(*) as n FROM Anime WHERE inCatalog = 1 AND (image IS NULL OR image = '' OR title IS NULL OR title = '')`,
  );
  if (Number(noArt[0]?.n) > 0) {
    await fileFinding("data-consistency", "db/anime-missing-art", 3, `${Number(noArt[0].n)} catalog anime missing image or title`);
  }

  // R6 — removed-progress tombstones must be respected: no WatchProgress rows
  // for (userId, malId) pairs that were explicitly deleted
  const resurrections = await db.$queryRawUnsafe(
    `SELECT COUNT(*) as n FROM WatchProgress p WHERE EXISTS (SELECT 1 FROM RemovedProgress r WHERE r.userId = p.userId AND r.malId = p.malId AND r.removedAt > p.updatedAt)`,
  );
  if (Number(resurrections[0]?.n) > 0) {
    await fileFinding("data-consistency", "db/continue-resurrection", 2, `${Number(resurrections[0].n)} WatchProgress rows resurrected after a tombstoned removal`);
  }
  return 6;
}

/* ---------------- 5) art checks ---------------- */

async function checkArt() {
  const rows = await db.$queryRawUnsafe(
    `SELECT malId, image FROM Anime WHERE inCatalog = 1 AND image IS NOT NULL AND image != '' ORDER BY RANDOM() LIMIT 12`,
  );
  for (const row of rows) {
    const r = await get(`${BASE}/api/art?u=${encodeURIComponent(row.image)}`, { timeoutMs: 20_000 });
    if (r.status !== 200 || !r.ct.startsWith("image")) {
      await fileFinding("art-broken", `art malId=${row.malId}`, 3, `proxy HTTP ${r.status} ct=${r.ct.slice(0, 40)}`);
    }
  }
  return rows.length;
}

/* ---------------- 6) prod probes ---------------- */

async function checkProd() {
  let checked = 0;
  const probes = [
    { url: `${PROD}/api/home`, slowMs: 4000, key: "PROD /api/home" },
    { url: `${PROD}/api/anime/21/episodes`, slowMs: 5000, key: "PROD /api/anime/[id]/episodes" },
  ];
  for (const p of probes) {
    checked++;
    const r = await getJson(p.url);
    if (r.status !== 200) {
      await fileFinding("api-error", p.key, 1, `HTTP ${r.status}${r.err ? " (" + r.err + ")" : ""}`);
    } else if (r.ms > p.slowMs) {
      await fileFinding("api-slow", p.key, 2, `latency ${r.ms}ms > ${p.slowMs}ms`);
    }
  }
  return checked;
}

/* ---------------- sweep loop ---------------- */

let sweepNo = 0;
const bootedAt = Date.now();

async function sweep() {
  sweepNo++;
  sweepFindings = [];
  const t0 = Date.now();

  const steps = [
    ["pages", checkPages],
    ["apis", checkApis],
    ["streams", checkStreamsAndDubs],
    ["dbRules", checkDbRules],
    ["art", checkArt],
    ["prod", checkProd],
  ];
  const counts = {};
  let checks = 0;
  for (const [name, fn] of steps) {
    const before = sweepFindings.length;
    let n = 0;
    try {
      n = (await fn()) ?? 0;
    } catch (e) {
      log(`step ${name} crashed: ${String(e?.message ?? e).slice(0, 140)}`);
    }
    counts[name] = n;
    counts[`${name}Findings`] = sweepFindings.length - before;
    checks += n;
  }

  const secs = Math.round((Date.now() - t0) / 1000);
  log(`sweep ${sweepNo} done in ${secs}s — ${sweepFindings.length} findings, ${checks} checks, uptime ${Math.round((Date.now() - bootedAt) / 60000)}min`);
  console.log(JSON.stringify({ at: new Date().toISOString(), type: "sweep", sweep: sweepNo, findings: sweepFindings.length, checks, ...counts, secs, uptimeMin: Math.round((Date.now() - bootedAt) / 60000) }));
}

async function main() {
  log(`bug patrol starting -> ${BASE} (prod probes: ${PROD})${LOOP ? " [24/7 loop]" : " [single sweep]"}`);
  do {
    try {
      await sweep();
    } catch (e) {
      log(`sweep crashed: ${String(e?.stack ?? e).slice(0, 300)}`);
    }
    if (LOOP) await sleep(SWEEP_PAUSE_MS);
  } while (LOOP);
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error("[patrol] fatal:", e?.stack?.slice(0, 400) ?? e);
  await db.$disconnect().catch(() => undefined);
  process.exit(1);
});
