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
 *   { k:"psub", endpoint, keys:{p256dh,auth}, on:boolean }   // plain push subs converge too
 *   { k:"anin", endpoint, malId, title, image, on:boolean }  // per-anime episode bells
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
  | { k: "psub"; endpoint: string; keys: { p256dh: string; auth: string }; on: boolean; i: string }
  | { k: "anin"; endpoint: string; malId: number; title: string | null; image: string | null; on: boolean; i: string }
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

/** One publish with bounded retries — a single ntfy hiccup used to mean a
 *  PERMANENTLY lost message (wt undercount, a sub toggle never propagating,
 *  a missing news marker → duplicate push later). 3 attempts, short backoff,
 *  loud warn on final failure so Vercel logs at least show the gap. */
async function postMessageWithRetry(body: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 1_200));
    if (await postMessage(body)) return true;
  }
  console.warn("[global-log] publish failed after 3 attempts — message may be lost:", body.slice(0, 80));
  return false;
}

/** Serialized so concurrent flushes can't reorder messages. Resolves to
 *  whether the message actually reached the log. */
function enqueuePublish(msg: LogMsg): Promise<boolean> {
  const next = publishing.then(() => postMessageWithRetry(JSON.stringify(msg)));
  publishing = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
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
      const chunk = items.slice(i, i + FLUSH_MAX_ITEMS);
      void enqueuePublish({ k: "wt", day, items: chunk, i: INSTANCE }).then((ok) => {
        if (ok) return;
        // the publish failed even after retries — put the deltas back so a
        // later flush retries them instead of silently losing the seconds
        for (const it of chunk) {
          const key = `${day}|${it.m}`;
          const prev = pendingWt.get(key);
          pendingWt.set(key, { d: (prev?.d ?? 0) + it.d, t: it.t ?? prev?.t, i: it.i ?? prev?.i, day });
        }
      });
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

/** Plain push-subscription change — WITHOUT this, a device that enabled bell
 *  notifications on instance A was invisible to instance B's sweeps (empty
 *  PushSub there) and its episode/Top10 pushes silently never fired. */
export function logPushSub(
  endpoint: string,
  keys: { p256dh: string; auth: string },
  on: boolean,
): void {
  enqueuePublish({ k: "psub", endpoint, keys, on, i: INSTANCE });
  void flushNow();
}

/** Per-anime episode-bell change (NotifyNextToggle) — same convergence gap. */
export function logAnimeNotify(endpoint: string, malId: number, title: string | null, image: string | null, on: boolean): void {
  enqueuePublish({ k: "anin", endpoint, malId, title, image, on, i: INSTANCE });
  void flushNow();
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

/**
 * One poll of the log with a GENEROUS timeout. 8s used to be enough for the
 * sandbox but cold Vercel lambdas routinely miss it (DNS + TLS + ntfy hiccups
 * take >8s), and a failed harvest silently serves LOCAL state — which is
 * exactly how two devices landed on different "Most Watched" lists (each hit
 * a different instance, each with a different last-successful-harvest).
 * The cursor only advances after a successful parse, so retrying is free.
 */
async function pollLog(since: string): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1_500));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15_000);
    try {
      const res = await fetch(`https://ntfy.sh/${TOPIC}/json?poll=1&since=${encodeURIComponent(since)}`, {
        signal: ac.signal,
        cache: "no-store",
      });
      if (res.ok) return await res.text();
    } catch {
      /* retry */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** Replay the global log into this instance's SQLite (idempotent). */
export async function harvest(): Promise<void> {
  if (harvesting) return harvesting;
  harvesting = (async () => {
    try {
      // publish anything WE still owe the log first, so a reader on this
      // instance never ranks without its own latest deltas
      flushWt();
      const meta = await db.globalMeta.findUnique({ where: { key: `logcursor:${TOPIC}` } });
      // first-ever harvest on a fresh instance: replay the FULL ntfy retention
      // window (~12h). The old 10m default meant every cold container missed
      // ~98% of the retained log — Most Watched diverged per instance and
      // subscription/news state started mostly empty until users re-toggled.
      const since = meta?.value ?? "12h";
      const text = await pollLog(since);
      if (text == null) return; // both attempts failed — serve local state, retry on the next read

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
        // APPLIED-CLAIM LEDGER: PushLog doubles as an idempotency guard so a
        // replayed message (cursor-write failure, retried backlog) can never
        // double-apply — a wt replay used to double-count seconds and skew
        // Most Watched for everyone. Failed applies release their claim so
        // the next harvest retries them.
        if (ev.id) {
          try {
            await db.pushLog.create({ data: { key: `applied:${TOPIC}:${ev.id}` } });
          } catch {
            continue; // already applied by an earlier harvest on this instance
          }
        }
        try {
          if (msg.k === "wt") await applyWt(msg.day, msg.items);
          else if (msg.k === "sub") await applySub(msg);
          else if (msg.k === "psub") await applyPsub(msg);
          else if (msg.k === "anin") await applyAnin(msg);
          else if (msg.k === "news") await applyNewsMarker(msg.key);
        } catch (err) {
          if (ev.id) await db.pushLog.delete({ where: { key: `applied:${TOPIC}:${ev.id}` } }).catch(() => undefined);
          console.warn("[global-log] apply failed for one message:", err instanceof Error ? err.message : err);
        }
      }
      if (lastId) {
        await db.globalMeta
          .upsert({ where: { key: `logcursor:${TOPIC}` }, create: { key: `logcursor:${TOPIC}`, value: lastId }, update: { value: lastId } })
          .catch((err: unknown) => {
            // a failed cursor write used to silently replay the whole window —
            // now safe (the applied-claims above skip replays), but still loud
            console.warn("[global-log] cursor write failed:", err instanceof Error ? err.message : err);
          });
        // claims only need to outlive the ntfy replay window (~12h) — prune
        // older ones so the ledger cannot grow unbounded
        await db.pushLog
          .deleteMany({
            where: { key: { startsWith: `applied:${TOPIC}:` }, createdAt: { lt: new Date(Date.now() - 2 * 86_400_000) } },
          })
          .catch(() => undefined);
      }
    } catch (err) {
      // log unreachable — serve local state (same as pre-log behavior), but
      // leave a trace: silent convergence gaps were impossible to debug
      console.warn("[global-log] harvest failed — serving local state only:", err instanceof Error ? err.message : err);
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
    // ATOMIC increment — the old read-then-write raced concurrent watchtime
    // POSTs on this instance and SET the summed value back, erasing deltas
    await db.watchStat
      .upsert({
        where: { day_malId: { day, malId: it.m } },
        create: { day, malId: it.m, seconds, title: it.t ?? null, image: it.i ?? null },
        update: { seconds: { increment: seconds }, title: it.t ?? undefined, image: it.i ?? undefined },
      })
      .catch(() => undefined);
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

async function applyPsub(msg: Extract<LogMsg, { k: "psub" }>): Promise<void> {
  if (!/^https:\/\//.test(msg.endpoint)) return;
  if (msg.on) {
    await db.pushSub
      .upsert({ where: { endpoint: msg.endpoint }, create: { endpoint: msg.endpoint, p256dh: msg.keys.p256dh, auth: msg.keys.auth }, update: { p256dh: msg.keys.p256dh, auth: msg.keys.auth } })
      .catch(() => undefined);
  } else {
    await db.pushSub.deleteMany({ where: { endpoint: msg.endpoint } }).catch(() => undefined);
  }
}

async function applyAnin(msg: Extract<LogMsg, { k: "anin" }>): Promise<void> {
  if (!/^https:\/\//.test(msg.endpoint) || !Number.isFinite(msg.malId)) return;
  if (msg.on) {
    await db.animeNotify
      .upsert({
        where: { endpoint_malId: { endpoint: msg.endpoint, malId: msg.malId } },
        create: { endpoint: msg.endpoint, malId: msg.malId, title: msg.title, image: msg.image },
        update: { title: msg.title ?? undefined, image: msg.image ?? undefined },
      })
      .catch(() => undefined);
  } else {
    await db.animeNotify.deleteMany({ where: { endpoint: msg.endpoint, malId: msg.malId } }).catch(() => undefined);
  }
}

async function applyNewsMarker(key: string): Promise<void> {
  await db.pushLog.create({ data: { key } }).catch(() => undefined);
}
