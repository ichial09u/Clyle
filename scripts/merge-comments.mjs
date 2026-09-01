/**
 * Merge a /api/export dump INTO the local SQLite (db/custom.db) without
 * losing or double-counting anything:
 *   - users        -> upsert by id
 *   - comments     -> upsert by id (createdAt preserved; parents linked in a
 *                     second pass so FK order never matters)
 *   - watchStats   -> upsert (day, malId), keep the MAX seconds (never sum)
 *   - top10Events  -> insert-skip (unique (type, malId, day) guards dupes)
 *   - top10Meta    -> upsert, keep the OLDER lastSealed cursor (re-sealing is
 *                     idempotent, so moving backwards is always safe)
 *
 * Usage: node scripts/merge-comments.mjs db/export-comments.tmp.json
 */
import { readFileSync, unlinkSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/merge-comments.mjs <export.json>");
  process.exit(1);
}

const data = JSON.parse(readFileSync(file, "utf8"));
const stats = { users: 0, comments: 0, watchStats: 0, top10Events: 0, top10Meta: 0, tombstones: 0 };

// tombstones FIRST: remove comments deleted on the live site so a stale
// bundled copy can't resurrect them (also keeps the local tombstone table)
const tombstones = data.deletedCommentIds ?? [];
if (tombstones.length) {
  const r = await db.comment.deleteMany({ where: { id: { in: tombstones } } });
  stats.tombstones = r.count;
  for (const id of tombstones) {
    await db.deletedComment.create({ data: { id } }).catch(() => undefined);
  }
}

for (const u of data.users ?? []) {
  await db.user.upsert({
    where: { id: u.id },
    update: { nickname: u.nickname ?? "Username", avatar: u.avatar ?? null },
    create: { id: u.id, nickname: u.nickname ?? "Username", avatar: u.avatar ?? null },
  });
  stats.users += 1;
}

// pass 1: rows without parents (and rows whose parent we may not have yet)
for (const c of data.comments ?? []) {
  await db.comment.upsert({
    where: { id: c.id },
    update: {
      nickname: c.nickname,
      avatar: c.avatar ?? null,
      text: c.text,
      likedBy: c.likedBy ?? "[]",
      ...(c.createdAt ? { createdAt: new Date(c.createdAt) } : {}),
    },
    create: {
      id: c.id,
      malId: c.malId,
      userId: c.userId,
      nickname: c.nickname,
      avatar: c.avatar ?? null,
      text: c.text,
      likedBy: c.likedBy ?? "[]",
      ...(c.createdAt ? { createdAt: new Date(c.createdAt) } : {}),
    },
  });
  stats.comments += 1;
}
// pass 2: (re)attach replies now that every parent exists
for (const c of data.comments ?? []) {
  if (c.parentId) {
    await db.comment.update({ where: { id: c.id }, data: { parentId: c.parentId } }).catch(() => undefined);
  }
}

for (const w of data.watchStats ?? []) {
  const existing = await db.watchStat.findUnique({ where: { day_malId: { day: w.day, malId: w.malId } } });
  if (existing) {
    if (w.seconds > existing.seconds) {
      await db.watchStat.update({ where: { id: existing.id }, data: { seconds: w.seconds, title: w.title ?? existing.title, image: w.image ?? existing.image } });
    }
  } else {
    await db.watchStat.create({ data: { day: w.day, malId: w.malId, seconds: w.seconds, title: w.title ?? null, image: w.image ?? null } });
  }
  stats.watchStats += 1;
}

for (const e of data.top10Events ?? []) {
  await db.top10Event.upsert({
    where: { type_malId_day: { type: e.type, malId: e.malId, day: e.day } },
    update: {},
    create: { type: e.type, malId: e.malId, day: e.day, title: e.title, image: e.image ?? null, rank: e.rank ?? null, ...(e.createdAt ? { createdAt: new Date(e.createdAt) } : {}) },
  }).catch(() => undefined);
  stats.top10Events += 1;
}

let lastSealed;
for (const m of data.top10Meta ?? []) {
  if (m.key !== "top10.lastSealed") continue;
  lastSealed = lastSealed && lastSealed < m.value ? lastSealed : m.value;
}
if (lastSealed) {
  await db.top10Meta.upsert({
    where: { key: "top10.lastSealed" },
    update: { value: lastSealed },
    create: { key: "top10.lastSealed", value: lastSealed },
  });
  stats.top10Meta += 1;
}

try { unlinkSync(file); } catch { /* keep on failure */ }
console.log(`merged: ${stats.users} users, ${stats.comments} comments (${stats.tombstones} tombstoned deletion(s) applied), ${stats.watchStats} watchStat rows, ${stats.top10Events} events, lastSealed=${lastSealed ?? "n/a"}`);
process.exit(0);
