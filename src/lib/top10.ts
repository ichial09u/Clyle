import { db } from "@/lib/db";

/**
 * Top 10 Today — membership history engine.
 *
 * The rail itself is pure WatchStat ranking (see /api/watchtime). This module
 * layers notifications + streaks on top:
 *
 *  - "enter" notification — an anime shows up in a day's Top 10 and was NOT
 *    in the last published day's list.
 *  - "leave" notification — a published day completes without an anime that
 *    was in the previous published list.
 *  - streak — consecutive published days in the Top 10, which powers the
 *    Netflix-style "Nw in the Top 10" badge on the rail.
 *
 * Days are "published" (sealed) once they are complete: the seal runs lazily
 * on the first request that touches a real current day. A day with zero
 * watch traffic app-wide does NOT publish at all — the last real list simply
 * carries over, so a quiet stretch never mass-evicts everyone (and a deploy
 * that resets the SQLite file can't fake a wave of "left" notifications).
 */

export const TOP10_SIZE = 10;

/** How far back streaks are counted (10 weeks — Netflix rarely shows more). */
const STREAK_LOOKBACK_DAYS = 70;

/** Max catch-up when sealing after downtime — older days become the baseline. */
const SEAL_CATCHUP_DAYS = 14;

const META_KEY = "top10.lastSealed";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface Top10Member {
  malId: number;
  rank: number;
  seconds: number;
  title: string;
  image: string | null;
}

/** Calendar math on "YYYY-MM-DD" strings (UTC-safe, no DST surprises). */
export function top10DayOffset(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

export function top10UtcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * "Current-ish" days are the only ones allowed to drive notifications:
 * yesterday through tomorrow (UTC). Scratch/probe days (smoke bot posts to
 * 1970-01-01) never pollute the feed.
 */
export function isCurrentishTop10Day(day: string): boolean {
  if (!DAY_RE.test(day)) return false;
  const today = top10UtcToday();
  return day >= top10DayOffset(today, -1) && day <= top10DayOffset(today, 1);
}

/** The day's Top 10: 10 most-watched anime by real seconds (stable tie-break). */
export async function top10ForDay(day: string): Promise<Top10Member[]> {
  const rows = await db.watchStat.findMany({
    where: { day },
    orderBy: [{ seconds: "desc" }, { updatedAt: "asc" }],
    take: TOP10_SIZE,
  });
  return rows.map((r, i) => ({
    malId: r.malId,
    rank: i + 1,
    seconds: r.seconds,
    title: r.title || `Anime ${r.malId}`,
    image: r.image ?? null,
  }));
}

/**
 * The most recent day BEFORE `day` that actually published a list (i.e. had
 * watch traffic). Used as the diff base so a quiet day in between doesn't
 * make a continuing member look like a fresh entry.
 */
async function previousPublishedMembership(day: string): Promise<{ day: string; members: Top10Member[] }> {
  for (let i = 1; i <= SEAL_CATCHUP_DAYS; i++) {
    const d = top10DayOffset(day, -i);
    const members = await top10ForDay(d);
    if (members.length) return { day: d, members };
  }
  return { day: top10DayOffset(day, -1), members: [] };
}

interface PendingEvent {
  type: "enter" | "leave";
  malId: number;
  day: string;
  rank?: number;
  fallbackTitle: string;
  fallbackImage: string | null;
}

/** Insert events (catalog titles preferred), deduped per (type, malId, day). */
async function insertEvents(events: PendingEvent[]): Promise<void> {
  if (!events.length) return;
  const ids = [...new Set(events.map((e) => e.malId))];
  let cat = new Map<number, { title: string; image: string | null }>();
  try {
    const rows = await db.anime.findMany({
      where: { malId: { in: ids } },
      select: { malId: true, title: true, image: true },
    });
    cat = new Map(rows.map((a) => [a.malId, { title: a.title, image: a.image ?? null }]));
  } catch {
    /* catalog lookup is cosmetic — snapshots still carry title/image */
  }
  for (const e of events) {
    const c = cat.get(e.malId);
    try {
      await db.top10Event.create({
        data: {
          type: e.type,
          malId: e.malId,
          day: e.day,
          rank: e.type === "enter" ? (e.rank ?? null) : null,
          title: (c?.title || e.fallbackTitle || `Anime ${e.malId}`).slice(0, 200),
          image: c?.image ?? e.fallbackImage ?? null,
        },
      });
    } catch {
      // unique violation = this (type, malId, day) was already notified
    }
  }
}

function diffEvents(day: string, members: Top10Member[], prev: Top10Member[]): PendingEvent[] {
  const ids = new Set(members.map((m) => m.malId));
  const prevIds = new Set(prev.map((m) => m.malId));
  return [
    ...members
      .filter((m) => !prevIds.has(m.malId))
      .map((m) => ({ type: "enter" as const, malId: m.malId, day, rank: m.rank, fallbackTitle: m.title, fallbackImage: m.image })),
    ...prev
      .filter((m) => !ids.has(m.malId))
      .map((m) => ({ type: "leave" as const, malId: m.malId, day, rank: undefined, fallbackTitle: m.title, fallbackImage: m.image })),
  ];
}

/**
 * Seal every completed day that published a list but wasn't diffed yet.
 * Idempotent + deduped, safe to call on any request; never throws.
 */
export async function sealTop10Days(): Promise<void> {
  try {
    const today = top10UtcToday();
    const yesterday = top10DayOffset(today, -1);
    const meta = await db.top10Meta.findUnique({ where: { key: META_KEY } });
    const raw = meta?.value;

    if (!raw || !DAY_RE.test(raw) || raw > yesterday) {
      // First run (or clock went backwards): everything up to yesterday
      // becomes the published baseline — notifications start from today.
      await db.top10Meta.upsert({
        where: { key: META_KEY },
        create: { key: META_KEY, value: yesterday },
        update: { value: yesterday },
      });
      return;
    }

    let lastSealed = raw;
    // Cold catch-up cap: don't flood the bell after long downtime.
    const earliest = top10DayOffset(today, -SEAL_CATCHUP_DAYS);
    if (lastSealed < top10DayOffset(earliest, -1)) lastSealed = top10DayOffset(earliest, -1);

    let prevMembers = (await previousPublishedMembership(top10DayOffset(lastSealed, 1))).members;
    let cursor = lastSealed;
    let guard = 0;
    while (cursor < yesterday && guard < 60) {
      guard += 1;
      const day = top10DayOffset(cursor, 1);
      const members = await top10ForDay(day);
      if (members.length) {
        await insertEvents(diffEvents(day, members, prevMembers));
        prevMembers = members;
        await db.top10Meta.upsert({
          where: { key: META_KEY },
          create: { key: META_KEY, value: day },
          update: { value: day },
        });
      }
      // empty day: no publish — the last real list carries over
      cursor = day;
    }
  } catch (err) {
    console.error("[top10] sealTop10Days failed:", err);
  }
}

/**
 * Live "entered" notifications while `day` is still filling up: any anime
 * currently in the day's Top 10 that wasn't in the last published list gets
 * an enter event immediately (so the bell has news the same day). Deduped.
 * Enters only — a day in progress never emits "left" (members may still
 * show up before midnight; leaves are the seal's job).
 */
export async function touchTop10EnterEvents(day: string): Promise<void> {
  try {
    const members = await top10ForDay(day);
    if (!members.length) return;
    const prev = (await previousPublishedMembership(day)).members;
    const enters = diffEvents(day, members, prev).filter((e) => e.type === "enter");
    await insertEvents(enters);
  } catch (err) {
    console.error("[top10] touchTop10EnterEvents failed:", err);
  }
}

/**
 * Consecutive-published-day Top 10 streaks, used for the Netflix-style
 * "Nw in the Top 10" badge. Days with zero app-wide watch traffic are
 * neutral (neither break nor extend the streak).
 */
export async function streaksForDay(day: string, malIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!malIds.length) return out;
  const from = top10DayOffset(day, -STREAK_LOOKBACK_DAYS);
  try {
    const rows = await db.watchStat.findMany({
      where: { day: { gte: from, lte: day } },
      select: { day: true, malId: true, seconds: true },
    });

    // group ALL rows per day first, then rank within the day — the global
    // seconds-desc ordering interleaves days, so contiguity can't be assumed
    const perDayRows = new Map<string, Array<{ malId: number; seconds: number }>>();
    for (const r of rows) {
      const arr = perDayRows.get(r.day);
      if (arr) arr.push({ malId: r.malId, seconds: r.seconds });
      else perDayRows.set(r.day, [{ malId: r.malId, seconds: r.seconds }]);
    }
    const perDay = new Map<string, Set<number>>();
    for (const [d, arr] of perDayRows) {
      arr.sort((a, b) => b.seconds - a.seconds);
      perDay.set(d, new Set(arr.slice(0, TOP10_SIZE).map((x) => x.malId)));
    }

    for (const id of malIds) {
      let streak = 0;
      let d = day;
      for (let i = 0; i <= STREAK_LOOKBACK_DAYS; i++) {
        if (d < from) break;
        const set = perDay.get(d);
        if (set) {
          if (!set.has(id)) break;
          streak += 1;
        }
        // no traffic that day → neutral, keep walking back
        d = top10DayOffset(d, -1);
      }
      out.set(id, Math.max(1, streak));
    }
  } catch (err) {
    console.error("[top10] streaksForDay failed:", err);
    for (const id of malIds) out.set(id, 1);
  }
  return out;
}
