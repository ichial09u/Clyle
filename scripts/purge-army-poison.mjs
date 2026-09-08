#!/usr/bin/env node
/**
 * Purge army-poisoned IntroScout rows.
 *
 * The repair bots' pair matcher sometimes aligned RECAP blocks across
 * consecutive episodes (recaps repeat identically too) and posted those as
 * "openings" — inconsistent per show (start spread up to 177s), and the
 * scout tier's anime-wide median then served a WRONG Skip Intro button to
 * EVERY episode of the show.
 *
 * Rule: for every show with army-posted rows (detail LIKE '%all-shows-army%'
 * from this campaign), keep the rows only if they form a tight cluster
 * (start spread <= 15s across all rows, i.e. the same opening measured
 * repeatedly). Inconsistent shows: delete ALL army rows (the hardened
 * repair guards will re-measure them honestly). Singletons: delete (one
 * self-graded interval, no cross-validation).
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const SINCE = new Date("2026-09-07T03:00:00Z"); // campaign start

const rows = await db.introScout.findMany({
  where: { detail: { contains: "all-shows-army" }, updatedAt: { gte: SINCE } },
  select: { id: true, malId: true, ep: true, start: true, end: true },
});
const byShow = new Map();
for (const r of rows) {
  if (!byShow.has(r.malId)) byShow.set(r.malId, []);
  byShow.get(r.malId).push(r);
}

const purgeIds = [];
const kept = [];
for (const [malId, rs] of byShow) {
  const starts = rs.map((r) => r.start).sort((a, b) => a - b);
  const spread = starts[starts.length - 1] - starts[0];
  if (rs.length >= 2 && spread <= 15) {
    kept.push(`${malId}(n=${rs.length})`);
    continue; // consistent — the same opening measured repeatedly: trust
  }
  purgeIds.push(...rs.map((r) => r.id));
}

if (purgeIds.length) {
  const res = await db.introScout.deleteMany({ where: { id: { in: purgeIds } } });
  console.log(`[purge] deleted ${res.count} poisoned rows across ${byShow.size - kept.length} shows`);
} else {
  console.log(`[purge] nothing to delete`);
}
console.log(`[purge] kept consistent shows: ${kept.join(" ") || "(none)"}`);
await db.$disconnect();
