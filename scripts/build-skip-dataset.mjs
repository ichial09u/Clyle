/**
 * Filter the AniSkip public CSV dump down to our catalog's malIds and
 * emit a compact JSON dataset: { malId: { ep: { op: [start, end], ed: [start, end] } } }
 * Only keeps op/ed rows with sane values and the highest-vote entry per group.
 * Output goes to src/lib/skip-times.data.json (vendored into the app).
 */
import { readFile, writeFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";

const csvPath = process.argv[2] || "scripts/aniskip_dump.csv";
const outPath = "src/lib/skip-times.data.json";

// Pull every malId we carry in the catalog — from the LIVE db (the old
// catalog-seed.ts only held the first 42 titles, which silently capped
// dataset coverage while the catalog grew past 2k animes).
const db = new PrismaClient();
const rows = await db.anime.findMany({ where: { inCatalog: true }, select: { malId: true } });
const malSet = new Set(rows.map((r) => r.malId));
await db.$disconnect();
console.log(`catalog animes: ${malSet.size}`);

const text = await readFile(csvPath, "utf8");
const lines = text.trim().split("\n");
const header = lines.shift().split(",");

// rows keyed by malId -> ep -> type -> best (highest votes, sane interval)
const acc = new Map(); // malId -> Map(ep -> { op?, ed? })
let kept = 0, skipped = 0;

for (const line of lines) {
  const cols = line.split(",");
  if (cols.length < header.length) { skipped++; continue; }
  const row = Object.fromEntries(header.map((h, i) => [h, cols[i]]));
  const malId = Number(row.anime_id);
  if (!malSet.has(malId)) continue;

  const ep = Number(row.episode_number);
  const type = row.skip_type; // "op" | "ed"
  const start = Number(row.start_time);
  const end = Number(row.end_time);
  const votes = Number(row.votes) || 0;
  const epLen = Number(row.episode_length) || 0;

  if (!Number.isFinite(ep) || ep < 1 || !Number.isFinite(start) || !Number.isFinite(end)) { skipped++; continue; }
  if (type !== "op" && type !== "ed") { skipped++; continue; }
  if (end <= start) { skipped++; continue; }
  // sanity: interval must sit inside a plausible episode length
  if (epLen > 0 && (start > epLen || end > epLen + 30)) { skipped++; continue; }
  if (end - start > 400) { skipped++; continue; } // no 6-minute "op"

  if (!acc.has(malId)) acc.set(malId, new Map());
  const byEp = acc.get(malId);
  if (!byEp.has(ep)) byEp.set(ep, {});
  const slot = byEp.get(ep);
  const cur = slot[type];
  if (!cur || votes > cur.votes) slot[type] = { s: Math.round(start * 10) / 10, e: Math.round(end * 10) / 10, v: votes };
  kept++;
}

// Emit compact JSON
const out = {};
for (const [malId, byEp] of [...acc.entries()].sort((a, b) => a[0] - b[0])) {
  const eps = {};
  for (const [ep, slot] of [...byEp.entries()].sort((a, b) => a[0] - b[0])) {
    const item = {};
    if (slot.op) item.op = [slot.op.s, slot.op.e];
    if (slot.ed) item.ed = [slot.ed.s, slot.ed.e];
    if (Object.keys(item).length) eps[ep] = item;
  }
  if (Object.keys(eps).length) out[malId] = eps;
}

await writeFile(outPath, JSON.stringify(out), "utf8");

// Stats
const animeCovered = Object.keys(out).length;
let epRows = 0, opRows = 0, edRows = 0;
for (const eps of Object.values(out)) {
  epRows += Object.keys(eps).length;
  for (const it of Object.values(eps)) {
    if (it.op) opRows++;
    if (it.ed) edRows++;
  }
}
console.log(`rows kept=${kept} skipped=${skipped}`);
console.log(`animes covered: ${animeCovered}/${malSet.size}`);
console.log(`episodes with data: ${epRows}, op entries: ${opRows}, ed entries: ${edRows}`);
const size = (await writeFile(outPath, JSON.stringify(out)), 0);
const kb = (await readFile(outPath, "utf8")).length / 1024;
console.log(`output size: ${kb.toFixed(1)} KB -> ${outPath}`);
