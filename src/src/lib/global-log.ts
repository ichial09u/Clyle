import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";

/**
 * GLOBAL LOG — the cross-instance convergence channel.
 *
 * Why this exists: on Vercel every serverless instance gets its OWN /tmp copy
 * of the packaged SQLite database. Writes (watch seconds, push subs, ANN
 * track subs) land in one instance's copy and are invisible to the others —
 * so "Most Watched" ranked differently depending on which instance served
 * you, and notification subscriptions only worked on instances that happened
 * to see the subscribe call.
 *
 * The fix: every meaningful write is ALSO appended to a tiny public log
 * (ntfy.sh topic — no account, messages cached server-side ~12h). Every
 * instance REPLAYS the log (harvest) before reading global state, applying
 * foreign deltas into its own SQLite. After a harvest, every instance's
 * tables hold the SAME rows — one global truth, reached in ~seconds, no
 * external account, no schema zoo. The cursor (last applied ntfy message id)
 * persists per instance in GlobalMeta so replays are incremental.
 *
 * Message kinds:
 *   { k:"wt",   day, items:[{ m:malId, d:deltaSec, t:title, i:image }] }
 *   { k:"sub",  endpoint, keys:{p256dh,auth}, ann:{malId,annId,annName,title,image}, on:boolean }
 *   { k:"news", key }              // pushLog claim marker (ANN news sent)
 *
 * Own messages are skipped on harvest (the writing instance applied its delta
 * directly), so nothing double-counts. Volume is coalesced: watch beacons
 * batch per instance and flush at most every FLUSH_MS.
 */

const TOPIC = "clyle-wt-7qj2mf9ks4x";
const INSTANCE = randomUUID();
const FLUSH_MS = 90_000;
const FLUSH_MAX_ITEMS = 8;
const FETCH_TIMEOUT_MS = 8_000;

type WtItem = { m: number; d: number; t?: string; i?: string };
type LogMsg =
  | { k: "wt"; day: string; items: WtItem[]; i: string }
  | {
      k: "sub";
      endpoint: string;
      keys: { p256dh: string; auth: string };
      ann: { malId: number; annId: number | null; annName: string | null; title: string | null; image: string | null };
      on: boolean;
      i: string;
    }
  | { k: "news"; key: string; i: string };

/* ---------------- publish (write side) ---------------- */

let pendingWt = new Map<string, { d: number; t?: string; i?: string; day: string }>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let publishing: Promise<unknown> = Promise.resolve();

function postMessage(body: string): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  return fetch(`https://ntfy.sh/${TOPIC}`, {
    method: "POST",
    body,
    headers: { "X-Priority": "min", "X-Title": "clyle-log" },
    signal: ac.signal,
    cache: "no-store",
  })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => clearTimeout(timer));
}

/** Serialized so concurrent flushes can't reorder messages. */
function enqueuePublish(msg: LogMsg): void {
  publishing = publishing
    .then(() => postMessage(JSON.stringify(msg)))
    .catch(() => undefined);
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushWt();
  }, FLUSH_MS);
}

function flushWt(): void {
  if (pendingWt.size === 0) return;
  // group pending deltas by day, merge the map into per-day item lists
  const byDay = new Map<string, WtItem[]>();
  for (const [key, v] of pendingWt) {
    const [day, malIdStr] = key.split("|");
    const list = byDay.get(day) ?? [];
    list.push({ m: Number(malIdStr), d: v.d, t: v.t, i: v.i });
    byDay.set(day, list);
  }
  pendingWt = new Map();
  for (const [day, items] of byDay) {
    // keep the message well under ntfy's 4KB body cap
    for (let i = 0; i < items.length; i += FLUSH_MAX_ITEMS) {
      enqueuePublish({ k: "wt", day, items: items.slice(i, i + FLUSH_MAX_ITEMS), i: INSTANCE });
    }
  }
}

/**
 * Record watch seconds into the global log (coalesced). Skipped for the
 * smoke-bot scratch day so scripted runs never pollute the real ranking.
 */
export function logWatchDelta(day: string, malId: number, delta: number, title?: string | null, image?: string | null): void {
  if (day === "1970-01-01" || !Number.isFinite(malId) || !(delta > 0)) return;
  const key = `${day}|${malId}`;
  const prev = pendingWt.get(key);
  pendingWt.set(key, {
    d: (prev?.d ?? 0) + Math.round(delta),
    t: title ?? prev?.t,
    i: image ?? prev?.i,
    day,
  });
  scheduleFlush();
  if (pendingWt.size >= FLUSH_MAX_ITEMS * 3) flushWt(); // burst guard
}

/** ANN track sub change (also converges PushSub keys across instances). */
export function logAnnSub(
  endpoint: string,
  keys: { p256dh: string; auth: string },
  ann: { malId: number; annId: number | null; annName: string | null; title: string | null; image: string | null },
  on: boolean,
): void {
  enqueuePublish({ k: "sub", endpoint, keys, ann, on, i: INSTANCE });
  void flushNow(); // subs matter promptly; flush the wt queue alongside
}

/** A push was sent for this claim key — other instances must not resend. */
export function logNewsSent(key: string): void {
  enqueuePublish({ k: "news", key, i: INSTANCE });
}

/** Await any queued publishes (used before sweep reads). */
export async function flushNow(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushWt();
  await publishing;
}

/* ---------------- harvest (read side) ---------------- */

let harvesting: Promise<void> | null = null;

/** Replay the global log into this instance's SQLite (idempotent). */
export async function harvest(): Promise<void> {
  if (harvesting) return harvesting;
  harvesting = (async () => {
    try {
      // publish anything WE still owe the log first, so a reader on this
      // instance never ranks without its own latest deltas
      flushWt();
      const meta = await db.globalMeta.findUnique({ where: { key: `logcursor:${TOPIC}` } });
      const since = meta?.value ?? "10m";
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      let text: string;
      try {
        const res = await fetch(`https://ntfy.sh/${TOPIC}/json?poll=1&since=${encodeURIComponent(since)}`, {
          signal: ac.signal,
          cache: "no-store",
        });
        if (!res.ok) return;
        text = await res.text();
      } finally {
        clearTimeout(timer);
      }

      let lastId: string | null = null;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let ev: { id?: string; event?: string; message?: string };
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.id) lastId = ev.id;
        if (ev.event !== "message" || !ev.message) continue;
        let msg: LogMsg;
        try {
          msg = JSON.parse(ev.message);
        } catch {
          continue;
        }
        if (msg.i === INSTANCE) continue; // own write — already applied
        try {
          if (msg.k === "wt") await applyWt(msg.day, msg.items);
          else if (msg.k === "sub") await applySub(msg);
          else if (msg.k === "news") await applyNewsMarker(msg.key);
        } catch {
          /* one bad message must not break the replay */
        }
      }
      if (lastId) {
        await db.globalMeta
          .upsert({ where: { key: `logcursor:${TOPIC}` }, create: { key: `logcursor:${TOPIC}`, value: lastId }, update: { value: lastId } })
          .catch(() => undefined);
      }
    } catch {
      /* log unreachable — serve local state (same as pre-log behavior) */
    } finally {
      harvesting = null;
    }
  })();
  return harvesting;
}

async function applyWt(day: string, items: WtItem[]): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day === "1970-01-01") return;
  for (const it of items) {
    if (!Number.isFinite(it.m) || !(it.d > 0)) continue;
    const seconds = Math.min(Math.round(it.d), 6 * 3600); // sanity cap
    const existing = await db.watchStat.findUnique({ where: { day_malId: { day, malId: it.m } } });
    if (existing) {
      await db.watchStat.update({ where: { id: existing.id }, data: { seconds: existing.seconds + seconds, title: it.t ?? existing.title, image: it.i ?? existing.image } });
    } else {
      await db.watchStat.create({ data: { day, malId: it.m, seconds, title: it.t ?? null, image: it.i ?? null } }).catch(() => undefined);
    }
  }
}

async function applySub(msg: Extract<LogMsg, { k: "sub" }>): Promise<void> {
  const { endpoint, keys, ann, on } = msg;
  if (!/^https:\/\//.test(endpoint) || !Number.isFinite(ann.malId)) return;
  if (on) {
    await db.pushSub
      .upsert({ where: { endpoint }, create: { endpoint, p256dh: keys.p256dh, auth: keys.auth }, update: { p256dh: keys.p256dh, auth: keys.auth } })
      .catch(() => undefined);
    await db.annTrackSub
      .upsert({
        where: { endpoint_malId: { endpoint, malId: ann.malId } },
        create: { endpoint, malId: ann.malId, annId: ann.annId, annName: ann.annName, title: ann.title, image: ann.image },
        update: { annId: ann.annId, annName: ann.annName, title: ann.title, image: ann.image },
      })
      .catch(() => undefined);
  } else {
    await db.annTrackSub.deleteMany({ where: { endpoint, malId: ann.malId } }).catch(() => undefined);
  }
}

async function applyNewsMarker(key: string): Promise<void> {
  await db.pushLog.create({ data: { key } }).catch(() => undefined);
}
