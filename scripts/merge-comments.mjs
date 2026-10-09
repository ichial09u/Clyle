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
import { createRequire } from "node:module";

// ESM resolves bare specifiers relative to THIS file (scripts/ has no
// node_modules) — anchor the resolution at the app's package.json instead,
// so the deploy script can spawn this from any cwd.
const { PrismaClient } = createRequire("/home/z/my-project/src/package.json")("@prisma/client");

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

// top10Events are deliberately NOT carried forward anymore: notifications
// were reset (user request) and the new rank-change feed starts empty —
// re-importing the prod feed would resurrect the pre-reset enter/leave rows.

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
        // per-episode dub boundaries: whichever side was probed more recently
        // wins (checkedAt advances on every definitive probe; the boundaries
        // are monotonic between checks)
        ...((a.dubThruCheckedAt ? new Date(a.dubThruCheckedAt).getTime() : 0) >
        (existing.dubThruCheckedAt ? existing.dubThruCheckedAt.getTime() : 0)
          ? {
              dubThruS1: a.dubThruS1 ?? null,
              dubHiS1: a.dubHiS1 ?? null,
              dubThruS2: a.dubThruS2 ?? null,
              dubHiS2: a.dubHiS2 ?? null,
              dubThruCheckedAt: a.dubThruCheckedAt ? new Date(a.dubThruCheckedAt) : null,
            }
          : {}),
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

// intro-scout fleet carry-forward: measured openings + per-anime reference
// fingerprints (Skip Intro accuracy data). Merge keeps the more-agreed row
// (bots is the agreement counter) so neither side can silently downgrade.
// The nodetect flag rides along — dropping it used to resurrect establish
// failures as {0,0} "measurements" (the skip button then trusted a zero
// interval). Garbage verdicts (establish pair failed / stream unavailable)
// are never carried — the fleet re-classes them as retryable errors.
for (const s of data.introScout ?? []) {
  const detail = s.detail ?? null;
  const poison = typeof detail === "string" && (detail.includes("establish pair failed") || detail.includes("stream unavailable"));
  if (poison) continue;
  const existing = await db.introScout.findUnique({ where: { malId_ep: { malId: s.malId, ep: s.ep } } });
  if (!existing) {
    await db.introScout.create({
      data: { malId: s.malId, ep: s.ep, start: s.start, end: s.end, quality: s.quality ?? 0, bots: s.bots ?? 1, server: s.server === "kiwi" ? "kiwi" : "zoko", detail, nodetect: !!s.nodetect },
    }).catch(() => undefined);
  } else if ((s.bots ?? 1) > existing.bots) {
    await db.introScout.update({
      where: { id: existing.id },
      data: { start: s.start, end: s.end, quality: s.quality ?? existing.quality, bots: s.bots ?? existing.bots, nodetect: !!s.nodetect, detail: detail ?? existing.detail },
    }).catch(() => undefined);
  }
}
for (const r of data.scoutRef ?? []) {
  await db.scoutRef.upsert({
    where: { malId: r.malId },
    update: {},
    create: { malId: r.malId, start: r.start, end: r.end, env: r.env ?? "[]" },
  }).catch(() => undefined);
}

// per-episode dub probes (ground truth behind the DUB button gating) —
// newest measurement wins per (malId, ep, chain)
let dubProbes = 0;
for (const d of data.dubProbe ?? []) {
  const chain = d.chain === "s2" ? "s2" : "s1";
  const existing = await db.dubProbe.findUnique({ where: { malId_ep_chain: { malId: d.malId, ep: d.ep, chain } } });
  const prodAt = d.updatedAt ? new Date(d.updatedAt).getTime() : 0;
  const localAt = existing ? existing.updatedAt.getTime() : 0;
  if (!existing || prodAt > localAt) {
    await db.dubProbe.upsert({
      where: { malId_ep_chain: { malId: d.malId, ep: d.ep, chain } },
      update: { ok: !!d.ok, provider: d.provider ?? null, detail: d.detail ?? null },
      create: { malId: d.malId, ep: d.ep, chain, ok: !!d.ok, provider: d.provider ?? null, detail: d.detail ?? null },
    }).catch(() => undefined);
    dubProbes++;
  }
}

// Web Push subscriptions — endpoint-keyed, straight upsert (the client also
// re-upserts on every app open; this makes the BAKED db notify-ready so cron
// pushes work even before any browser revisits)
let pushSubs = 0;
for (const s of data.pushSubs ?? []) {
  if (!s?.endpoint || !s?.p256dh || !s?.auth) continue;
  await db.pushSub.upsert({
    where: { endpoint: s.endpoint },
    update: { p256dh: s.p256dh, auth: s.auth, userId: s.userId ?? null },
    create: { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth, userId: s.userId ?? null },
  }).catch(() => undefined);
  pushSubs++;
}

try { unlinkSync(file); } catch { /* keep on failure */ }
console.log(`merged: ${stats.users} users, ${stats.comments} comments (${stats.tombstones} tombstoned deletion(s) applied), ${stats.watchStats} watchStat rows, ${stats.top10Events} events, anime +${stats.anime}, episodes +${stats.episodes}, progress +${stats.progress}, dubProbes ${dubProbes}, pushSubs ${pushSubs}, lastSealed=${lastSealed ?? "n/a"}`);
process.exit(0);
