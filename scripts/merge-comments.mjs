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
const stats = { users: 0, comments: 0, watchStats: 0, top10Events: 0, top10Meta: 0, tombstones: 0, anime: 0, episodes: 0, progress: 0 };

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
    create: { type: e.type, malId: e.malId, day: e.day, title: e.title, image: e.image ?? null, rank: e.rank ?? null, weeks: e.weeks ?? null, ...(e.createdAt ? { createdAt: new Date(e.createdAt) } : {}) },
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

// ---- catalog carry-forward (additive-only; local curation always wins) ----
// The live catalog accumulates on prod (imports, sync). Without this block a
// deploy would reset the catalog to whatever the local working tree has.
for (const a of data.anime ?? []) {
  const existing = await db.anime.findUnique({ where: { malId: a.malId } });
  if (!existing) {
    // strip row-identity fields Prisma must not receive on create
    const { createdAt: _c, updatedAt: _u, lastSyncedAt: _l, ...rest } = a;
    await db.anime.create({ data: { ...rest, createdAt: a.createdAt ? new Date(a.createdAt) : undefined } });
    stats.anime += 1;
  } else {
    await db.anime.update({
      where: { malId: a.malId },
      data: {
        inCatalog: true,
        // truthful dub verdicts + episode-count growth flow in; art, titles,
        // synopsis etc. stay LOCAL (manual overrides like One Piece's pinned
        // key visual must never be reverted by an older prod row)
        ...(a.totalEpisodes > existing.totalEpisodes ? { totalEpisodes: a.totalEpisodes } : {}),
        ...(typeof a.hasDub === "boolean" ? { hasDub: a.hasDub } : {}),
        ...(existing.logoUrl == null && a.logoUrl ? { logoUrl: a.logoUrl } : {}),
      },
    });
  }
}

const epRows = data.episodes ?? [];
if (epRows.length) {
  const byAnime = new Map();
  for (const e of epRows) {
    if (!byAnime.has(e.animeId)) byAnime.set(e.animeId, []);
    byAnime.get(e.animeId).push(e);
  }
  for (const [animeId, list] of byAnime) {
    const have = new Set(
      (await db.episode.findMany({ where: { animeId }, select: { number: true, lang: true } })).map(
        (e) => `${e.lang}:${e.number}`,
      ),
    );
    const missing = list.filter((e) => !have.has(`${e.lang}:${e.number}`));
    if (missing.length) {
      await db.episode.createMany({
        data: missing.map((e) => ({
          animeId: e.animeId,
          number: e.number,
          title: e.title ?? null,
          aired: e.aired ?? null,
          lang: e.lang === "dub" ? "dub" : "sub",
          filler: !!e.filler,
          recap: !!e.recap,
          ...(e.addedAt ? { addedAt: new Date(e.addedAt) } : {}),
        })),
      }).catch(() => undefined);
      stats.episodes += missing.length;
    }
  }
}

// continue-watching carry-forward: keep whichever row (local vs prod) is newer
for (const p of data.watchProgress ?? []) {
  // the User row must exist first (FK) — users were upserted above
  await db.user.upsert({ where: { id: p.userId }, update: {}, create: { id: p.userId } }).catch(() => undefined);
  const existing = await db.watchProgress.findUnique({
    where: { userId_malId_episode: { userId: p.userId, malId: p.malId, episode: p.episode } },
  });
  const updated = p.updatedAt ? new Date(p.updatedAt) : new Date(0);
  if (!existing) {
    await db.watchProgress.create({
      data: {
        userId: p.userId, malId: p.malId, episode: p.episode,
        lang: p.lang === "dub" ? "dub" : "sub",
        server: p.server === "kiwi" ? "kiwi" : "zoko",
        position: p.position ?? 0, duration: p.duration ?? 0,
        completed: !!p.completed, title: p.title ?? null, image: p.image ?? null,
        updatedAt: updated,
      },
    }).catch(() => undefined);
    stats.progress += 1;
  } else if (updated > existing.updatedAt) {
    await db.watchProgress.update({
      where: { id: existing.id },
      data: {
        position: p.position ?? existing.position,
        duration: p.duration ?? existing.duration,
        completed: !!p.completed,
        updatedAt: updated,
      },
    }).catch(() => undefined);
  }
}

try { unlinkSync(file); } catch { /* keep on failure */ }
console.log(`merged: ${stats.users} users, ${stats.comments} comments (${stats.tombstones} tombstoned deletion(s) applied), ${stats.watchStats} watchStat rows, ${stats.top10Events} events, anime +${stats.anime}, episodes +${stats.episodes}, progress +${stats.progress}, lastSealed=${lastSealed ?? "n/a"}`);
process.exit(0);
