/**
 * HARVEST the live prod catalog into the local db BEFORE the next deploy. (v2)
 *
 * Why: prod's writable DB lives in a lambda /tmp copy (src/lib/db.ts). The
 * mass import ("all animes Zoko has") ran there — ~2000 animes — and any new
 * deployment replaces the bundled SQLite with the LOCAL one. Without this
 * harvest the imported catalog would vanish on the next deploy.
 *
 * v2: enumeration SAVES the full lite row (home/latest/genre/search listing
 * endpoints already return AnimeLite), so phase 2 needs only ONE prod call
 * per anime (/episodes) instead of two — the slow /api/anime/{id} relations
 * fan-out is skipped entirely. Candidates + lite rows are cached in
 * /tmp/prod-catalog.json so re-runs resume instantly.
 */
const PROD = process.env.PROD_URL || "https://temporary-spry-granite-1f0h7ae.vercel.app";
const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function j(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) return null;
      await sleep(1200 * (i + 1));
    }
  }
}

// ---------- 1) enumerate candidates + capture lite rows ----------
const CACHE = "/tmp/prod-catalog.json";
let ids = new Set();
const lite = new Map(); // malId -> AnimeLite row
try {
  const { readFileSync } = await import("node:fs");
  const saved = JSON.parse(readFileSync(CACHE, "utf8"));
  if (Array.isArray(saved?.ids) && saved.ids.length) {
    for (const id of saved.ids) ids.add(id);
    for (const [k, v] of Object.entries(saved.lite ?? {})) lite.set(Number(k), v);
    console.log(`== cached enumeration: ${ids.size} ids, ${lite.size} lite rows ==`);
  }
} catch { /* enumerate below */ }

if (ids.size === 0) {
  const pushLite = (row) => {
    if (Number.isFinite(row?.malId)) {
      ids.add(row.malId);
      if (!lite.has(row.malId)) lite.set(row.malId, row);
    }
  };
  const pushList = (arr) => {
    for (const it of arr ?? []) pushLite(it?.anime ?? it);
  };

  console.log("== enumerating prod catalog ==");
  const home = await j(`${PROD}/api/home`);
  if (home) {
    pushList(home.hero);
    for (const s of home.sections ?? []) pushList(s.items);
  }
  console.log("after home:", ids.size);

  const latest = await j(`${PROD}/api/latest`);
  pushList(latest?.updates ?? latest);
  console.log("after latest:", ids.size);

  const genres = await j(`${PROD}/api/genres`);
  for (const g of genres?.genres ?? []) {
    const list = await j(`${PROD}/api/genre/${encodeURIComponent(g.name)}`);
    pushList(list?.catalog ?? list?.items);
    await sleep(100);
  }
  console.log("after genres:", ids.size);

  // export/continue enrichment (watched titles surface nowhere else)
  try {
    const dump = await j(`${PROD}/api/export`, 2);
    for (const w of dump?.watchStats ?? []) if (Number.isFinite(w.malId)) ids.add(w.malId);
    for (const e of dump?.top10Events ?? []) if (Number.isFinite(e.malId)) ids.add(e.malId);
    for (const uid of (dump?.users ?? []).map((u) => u.id)) {
      const c = await j(`${PROD}/api/continue?userId=${encodeURIComponent(uid)}`, 2);
      for (const it of c?.items ?? []) if (Number.isFinite(it.malId)) ids.add(it.malId);
      await sleep(120);
    }
  } catch { /* ignore */ }
  console.log("after export/continue enrich:", ids.size);

  // bigram walk (search requires q.length >= 2) — near-complete title coverage
  const letters = "abcdefghijklmnopqrstuvwxyz".split("");
  const bigrams = [];
  for (const a of letters) for (const b of letters) bigrams.push(a + b);
  for (let i = 0; i < bigrams.length; i += 12) {
    const batch = bigrams.slice(i, i + 12);
    const results = await Promise.all(batch.map((bg) => j(`${PROD}/api/search?q=${bg}`, 1)));
    for (const s of results) pushList(s?.catalog);
    if ((i / 12) % 10 === 0) console.log(`  bigram ${i}/${bigrams.length}, ids=${ids.size}`);
    await sleep(150);
  }
  console.log("after bigram walk:", ids.size);
}

// ---------- 2) harvest (parallel, resumable, lite rows reused) ----------
const all = [...ids];
const { writeFileSync } = await import("node:fs");
writeFileSync(CACHE, JSON.stringify({ ids: all, lite: Object.fromEntries(lite) }));
console.log(`== harvesting ${all.length} candidates (${lite.size} lite rows cached) ==`);

let addedAnime = 0, updatedAnime = 0, addedEps = 0, skipped = 0, fail = 0, done = 0;
const WORKERS = 6;

function liteToDbRow(a) {
  return {
    title: a.title,
    titleEnglish: a.titleEnglish,
    image: a.image,
    banner: a.banner,
    logoUrl: a.logo ?? null,
    synopsis: a.synopsis,
    type: a.type,
    ratingShort: a.ratingShort,
    status: a.status,
    airing: !!a.airing,
    season: a.season,
    year: a.year,
    durationMin: a.durationMin,
    score: a.score,
    rank: a.rank,
    popularity: a.popularity,
    genres: JSON.stringify(a.genres ?? []),
    totalEpisodes: a.totalEpisodes ?? 0,
  };
}

async function harvestOne(malId) {
  const pre = await db.anime.findUnique({
    where: { malId },
    select: { _count: { select: { episodes: true } } },
  });
  if (pre && pre._count.episodes > 0) { skipped++; return; }

  const eps = await j(`${PROD}/api/anime/${malId}/episodes`);
  if (!eps) { fail++; return; }
  const hasDubVerdict = eps.hasDub;
  const liteRow = lite.get(malId) ?? {
    malId,
    title: eps.title,
    titleEnglish: null,
    image: null, banner: null, synopsis: null, type: eps.type,
    ratingShort: null, status: null, airing: !!eps.airing, season: null, year: null,
    durationMin: eps.durationMin, score: null, rank: null, popularity: null,
    totalEpisodes: eps.total ?? 0, genres: [],
  };

  const existing = await db.anime.findUnique({ where: { malId } });
  const fresh = liteToDbRow(liteRow);
  if (!existing) {
    await db.anime.create({
      data: {
        malId,
        ...fresh,
        inCatalog: true,
        ...(hasDubVerdict === true || hasDubVerdict === false ? { hasDub: hasDubVerdict } : {}),
        source: liteRow.source ?? "manual",
      },
    });
    addedAnime++;
  } else {
    await db.anime.update({
      where: { malId },
      data: {
        inCatalog: true,
        // fill blanks without clobbering richer local rows
        ...(existing.image == null && fresh.image ? { image: fresh.image } : {}),
        ...(existing.banner == null && fresh.banner ? { banner: fresh.banner } : {}),
        ...(existing.synopsis == null && fresh.synopsis ? { synopsis: fresh.synopsis } : {}),
        ...(existing.logoUrl == null && fresh.logoUrl ? { logoUrl: fresh.logoUrl } : {}),
        ...(existing.titleEnglish == null && fresh.titleEnglish ? { titleEnglish: fresh.titleEnglish } : {}),
        ...(fresh.totalEpisodes > existing.totalEpisodes ? { totalEpisodes: fresh.totalEpisodes } : {}),
        ...(hasDubVerdict === true || hasDubVerdict === false ? { hasDub: hasDubVerdict } : {}),
      },
    });
    updatedAnime++;
  }

  // episodes (sub rows), pre-filtered — SQLite has no skipDuplicates
  const have = new Set(
    (await db.episode.findMany({ where: { animeId: malId, lang: "sub" }, select: { number: true } })).map((e) => e.number),
  );
  const epRows = (eps.episodes ?? [])
    .filter((e) => !have.has(e.number))
    .map((e) => ({
      animeId: malId,
      number: e.number,
      title: e.title ?? null,
      aired: e.aired ?? null,
      lang: "sub",
      ...(e.addedAt ? { addedAt: new Date(e.addedAt) } : {}),
    }));
  if (epRows.length) {
    const r = await db.episode.createMany({ data: epRows });
    addedEps += r.count;
  }

  done++;
  if (done % 25 === 0) console.log(`  ${done}/${all.length} (anime +${addedAnime} upd ${updatedAnime}, eps +${addedEps}, skip ${skipped}, fail ${fail})`);
}

for (let i = 0; i < all.length; i += WORKERS) {
  await Promise.all(all.slice(i, i + WORKERS).map((id) => harvestOne(id).catch(() => { fail++; })));
  await sleep(80);
}

console.log(`\nDONE: anime +${addedAnime} created, ${updatedAnime} updated, ${skipped} skipped, ${fail} failed; episodes +${addedEps}`);
const total = await db.anime.count({ where: { inCatalog: true } });
const epTotal = await db.episode.count();
console.log(`local catalog now: ${total} animes, ${epTotal} episodes`);
await db.$disconnect();
