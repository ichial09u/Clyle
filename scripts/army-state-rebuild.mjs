#!/usr/bin/env node
/**
 * Rebuild army ground truth from the DB after the log loss.
 * Reports:
 *  - total sub eps in catalog (excl One Piece)
 *  - eps with valid IntroScout coverage (start<end, !nodetect)
 *  - eps covered by skip-times.data.json (vendored tier)
 *  - eps covered by SkipDbFill
 *  - remaining = eps with NO coverage anywhere  (the real work left)
 *    split by: show has some scout rows (in-show gaps => repair queue)
 *              show has zero rows (=> skipdb-gap / never-touched shows)
 *  - poison check: per-show army-row start spread since 2026-09-07T03:00Z
 */
import { readFile, writeFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const EXCLUDE = new Set([21]);
const SINCE = new Date("2026-09-07T03:00:00Z");

const ds = (await import("../src/lib/skip-times.data.json", { with: { type: "json" } })).default;

const eps = await db.episode.findMany({
  where: { lang: "sub", animeId: { notIn: [...EXCLUDE] } },
  select: { animeId: true, number: true },
  orderBy: [{ animeId: "asc" }, { number: "asc" }],
});
const scouts = await db.introScout.findMany({
  select: { malId: true, ep: true, nodetect: true, start: true, end: true, detail: true, updatedAt: true },
});
const fills = await db.skipDbFill.findMany({ select: { malId: true, ep: true } });

const scoutKey = new Set();
const scoutByShow = new Map();
for (const s of scouts) {
  if (s.nodetect || !(s.end > s.start)) continue;
  scoutKey.add(`${s.malId}/${s.ep}`);
  if (!scoutByShow.has(s.malId)) scoutByShow.set(s.malId, []);
  scoutByShow.get(s.malId).push(s);
}
const fillKey = new Set(fills.map((f) => `${f.malId}/${f.ep}`));

function dsCovers(malId, ep) {
  const d = ds[String(malId)];
  if (!d) return false;
  const row = d[String(ep)] ?? d["0"];
  return !!(row && row.op);
}

let covered = 0, dsOnly = 0, fillOnly = 0, both = 0, none = 0;
const gapInMeasuredShow = new Map(); // malId -> [eps]
const gapShowsNoRows = new Map();    // malId -> [eps]
for (const e of eps) {
  const k = `${e.animeId}/${e.number}`;
  const s = scoutKey.has(k);
  const v = dsCovers(e.animeId, e.number);
  const f = fillKey.has(k);
  if (s || v || f) {
    covered++;
    if (s && v) both++;
    else if (s) dsOnly = dsOnly; // scout primary
    else if (v) dsOnly++;
    else if (f) fillOnly++;
  } else {
    none++;
    const hasRows = scoutByShow.has(e.animeId);
    if (hasRows) {
      if (!gapInMeasuredShow.has(e.animeId)) gapInMeasuredShow.set(e.animeId, []);
      gapInMeasuredShow.get(e.animeId).push(e.number);
    } else {
      if (!gapShowsNoRows.has(e.animeId)) gapShowsNoRows.set(e.animeId, []);
      gapShowsNoRows.get(e.animeId).push(e.number);
    }
  }
}

// poison check: army rows since campaign start, per-show start spread
const armyRows = scouts.filter(() => true); // need detail — refetch
const armyDetailed = await db.introScout.findMany({
  where: { detail: { contains: "all-shows-army" }, updatedAt: { gte: SINCE } },
  select: { id: true, malId: true, ep: true, start: true },
});
const spreadByShow = new Map();
for (const r of armyDetailed) {
  if (!spreadByShow.has(r.malId)) spreadByShow.set(r.malId, []);
  spreadByShow.get(r.malId).push(r.start);
}
let poisonShows = 0, cleanShows = 0, poisonRows = 0;
const poisonExamples = [];
for (const [malId, starts] of spreadByShow) {
  starts.sort((a, b) => a - b);
  const spread = starts[starts.length - 1] - starts[0];
  if (starts.length >= 2 && spread > 15) {
    poisonShows++;
    poisonRows += starts.length;
    if (poisonExamples.length < 8) poisonExamples.push(`malId ${malId}: n=${starts.length} spread=${spread}s range=${starts[0]}..${starts[starts.length - 1]}`);
  } else cleanShows++;
}

const out = {
  at: new Date().toISOString(),
  totalSubEps: eps.length,
  covered,
  coveredDsOnly: dsOnly,
  coveredFillOnly: fillOnly,
  coveredBoth: both,
  noCoverage: none,
  repairQueueEps: [...gapInMeasuredShow.values()].reduce((a, v) => a + v.length, 0),
  repairQueueShows: gapInMeasuredShow.size,
  untouchedShows: gapShowsNoRows.size,
  untouchedEps: [...gapShowsNoRows.values()].reduce((a, v) => a + v.length, 0),
  armyRowsSince: armyDetailed.length,
  poisonShows,
  cleanShows,
  poisonRows,
  poisonExamples,
  repairTop: [...gapInMeasuredShow.entries()].slice(0, 10).map(([m, e]) => `${m}(${e.length})`),
  untouchedTop: [...gapShowsNoRows.entries()].slice(0, 10).map(([m, e]) => `${m}(${e.length})`),
};
console.log(JSON.stringify(out, null, 2));
await writeFile("/home/z/my-project/scripts/army-state-rebuild.json", JSON.stringify(out, null, 2));
await db.$disconnect();
