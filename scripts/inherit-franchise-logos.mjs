/**
 * Franchise inheritance pass: a missing sequel/movie ("Hunter x Hunter:
 * Phantom Rouge") inherits the wordmark of its catalog franchise root
 * ("Hunter x Hunter") when one exists. Root key = normalized title with
 * seasons/parens/subtitles stripped; "One-Punch Man" can never inherit from
 * "ONE PIECE" because the whole stripped keys must be a prefix match.
 *
 * Copies the root's PNG to public/logos/<malId>.png and points logoUrl at it.
 */
import { copyFile, writeFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

function normKey(title) {
  return title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/\b(season|saison|part)\b.*$/i, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const rows = await db.anime.findMany({
  where: { inCatalog: true },
  select: { malId: true, title: true, titleEnglish: true, logoUrl: true },
});

const withLogo = rows.filter((r) => r.logoUrl);
const baseByKey = new Map();
for (const r of withLogo) {
  const name = (r.titleEnglish?.trim() || r.title).trim();
  const key = normKey(name);
  if (key.split(" ").length >= 1 && !baseByKey.has(key)) baseByKey.set(key, { ...r, name, key });
}

let inherited = 0;
for (const row of rows) {
  if (row.logoUrl) continue;
  const name = (row.titleEnglish?.trim() || row.title).trim();
  const key = normKey(name);
  if (!key) continue;
  // longest base key that prefixes this title; single-word roots allowed
  // when distinctive (naruto -> naruto shippuden) but never generic (one -> one punch man)
  let best = null;
  for (const [k, base] of baseByKey) {
    if (base.malId === row.malId) continue;
    if (!key.startsWith(k)) continue;
    const kw = k.split(" ");
    if (kw.length < 2 && (k.length < 5 || key === k)) continue;
    if (!best || kw.length > best.key.split(" ").length) best = base;
  }
  if (!best) {
    console.log(`MISS ${row.malId} ${name} (no franchise root with a logo)`);
    continue;
  }
  const src = best.logoUrl.startsWith("/logos/")
    ? `public${best.logoUrl}`
    : null;
  const dst = `public/logos/${row.malId}.png`;
  try {
    if (src) {
      await copyFile(src, dst);
    } else {
      // remote root logo (earlier image-search seed) — download it local so
      // the whole /logos/ set stays self-hosted
      const res = await fetch(best.logoUrl, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`root fetch ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 500) throw new Error("root too small");
      await writeFile(dst, buf);
    }
    await db.anime.update({ where: { malId: row.malId }, data: { logoUrl: `/logos/${row.malId}.png` } });
    console.log(`OK  ${row.malId} ${name} -> inherited ${best.name}'s wordmark`);
    inherited++;
  } catch (e) {
    console.log(`ERR ${row.malId}: ${String(e.message).slice(0, 80)}`);
  }
}

const set = await db.anime.count({ where: { inCatalog: true, NOT: { logoUrl: null } } });
const total = await db.anime.count({ where: { inCatalog: true } });
console.log(`\nInherited ${inherited} logos. Catalog logos: ${set}/${total}`);
await db.$disconnect();
