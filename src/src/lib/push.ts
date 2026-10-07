import webpush from "web-push";
import { db } from "@/lib/db";

/**
 * Web Push — "actual notifications that pop up when you're not in the app".
 *
 * Flow: the browser opt-ins (Top 10 bell panel toggle) -> its subscription
 * (endpoint + encryption keys) is stored as a PushSub row -> the server
 * fires signed payloads through web-push whenever something happens:
 *
 *   - NEW EPISODE  — a sync sweep imported a fresh episode ("out now")
 *   - NEW ANIME    — a sync sweep added a new series to the catalog
 *   - TOP 10       — the live ranking moved (one summary per day, quiet)
 *   - AIRING SOON  — the daily cron reminds: episode drops within 24h
 *
 * Delivery semantics: `pushOnce(key, ...)` claims a PushLog row BEFORE
 * sending, so overlapping syncs / cron runs can never double-notify. Failed
 * sends are logged, dead endpoints (404/410) are pruned. The client also
 * re-upserts its subscription on every app open, so lost rows self-heal.
 */

// Keys come from the Vercel env (set per-project); the literals below are the
// same pair as a local/dev fallback so the feature works out of the box.
const PUB = process.env.VAPID_PUBLIC_KEY || "BAQ1xiwtHteciTzdJP1igATqNLDUkAl_ysFeTo3kgadmIHyrdWfFgZiiB7qg7OtxWMrmbqydf7nO-nGLrgicTfU";
const PRIV = process.env.VAPID_PRIVATE_KEY || "b7d9w0VaokAbCzkZ7gtBXOx0yUx0zziI5mTJ905sWu8";
const SUBJECT = process.env.VAPID_SUBJECT || "mailto:clyle@anime.local";

let configured = false;
function ensureVapid(): boolean {
  if (configured) return true;
  try {
    webpush.setVapidDetails(SUBJECT, PUB, PRIV);
    configured = true;
    return true;
  } catch (err) {
    console.error("[push] vapid config failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

/** The public key the browser needs before it will create a subscription. */
export function pushPublicKey(): string {
  return PUB;
}

/** Payload the service worker receives (kept short — push messages are tiny). */
export interface PushPayload {
  t: string; // notification title
  b: string; // notification body
  tag?: string; // collapse key (replaces an older notification with same tag)
  url?: string; // where notificationclick lands (default "/")
  img?: string | null; // poster shown large where supported
}

/** Hard cap so one broadcast can never hold a lambda for minutes. */
const MAX_SUBS_PER_SEND = 300;
const PER_SEND_TIMEOUT_MS = 8_000;

/**
 * Fire `payload` at every stored subscription (or only at `onlyEndpoints`
 * when given). Never throws — push is best-effort by design and must not
 * break the sync/cron paths calling it.
 */
async function sendPushFiltered(payload: PushPayload, onlyEndpoints?: Set<string>): Promise<{ sent: number; pruned: number }> {
  if (!ensureVapid()) return { sent: 0, pruned: 0 };
  let sent = 0;
  let pruned = 0;
  let subs: Array<{ endpoint: string; p256dh: string; auth: string }> = [];
  try {
    subs = await db.pushSub.findMany({
      select: { endpoint: true, p256dh: true, auth: true },
      take: MAX_SUBS_PER_SEND,
      orderBy: { updatedAt: "desc" },
    });
  } catch (err) {
    console.error("[push] sub list failed:", err instanceof Error ? err.message : err);
    return { sent: 0, pruned: 0 };
  }
  const json = JSON.stringify(payload);
  for (const s of subs) {
    if (onlyEndpoints && !onlyEndpoints.has(s.endpoint)) continue;
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        json,
        { TTL: 3 * 24 * 3600, headers: { Urgency: "high" } },
      );
      sent++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        // subscription gone (browser uninstalled / permission revoked) — prune
        await db.pushSub.deleteMany({ where: { endpoint: s.endpoint } }).catch(() => undefined);
        await db.animeNotify.deleteMany({ where: { endpoint: s.endpoint } }).catch(() => undefined);
        pruned++;
      } else {
        console.error(`[push] send failed (${status ?? "no-status"}):`, err instanceof Error ? err.message.slice(0, 120) : err);
      }
    }
  }
  if (subs.length) console.log(`[push] "${payload.t}" -> ${sent} sent, ${pruned} pruned, of ${subs.length}${onlyEndpoints ? ` (${onlyEndpoints.size} targeted)` : " broadcast"}`);
  return { sent, pruned };
}

async function sendPushAll(payload: PushPayload): Promise<{ sent: number; pruned: number }> {
  return sendPushFiltered(payload);
}

/**
 * Send at most once per `key` (PushLog claim-first). Returns true when the
 * send actually happened (first caller wins; everyone else free-rides).
 *
 * `onlyAnimeSubsOf`: send ONLY to devices that subscribed to that anime's
 * next-episode notifications (the details-page bell / "that anime only")
 * instead of broadcasting. When nobody subscribed, nothing is sent and false
 * is returned without claiming the log key — a subscriber who joins before
 * the drop still gets it on a later sweep.
 */
export async function pushOnce(key: string, payload: PushPayload, opts: { onlyAnimeSubsOf?: number } = {}): Promise<boolean> {
  let targets: Set<string> | undefined;
  if (opts.onlyAnimeSubsOf != null) {
    try {
      const rows = await db.animeNotify.findMany({
        where: { malId: opts.onlyAnimeSubsOf },
        select: { endpoint: true },
        take: MAX_SUBS_PER_SEND,
      });
      if (!rows.length) return false; // nobody asked for this anime
      const live = await db.pushSub.findMany({
        where: { endpoint: { in: rows.map((r) => r.endpoint) } },
        select: { endpoint: true },
      });
      targets = new Set(live.map((r) => r.endpoint));
      if (!targets.size) return false;
    } catch (err) {
      console.error("[push] anime-sub lookup failed:", err instanceof Error ? err.message : err);
      return false;
    }
  }
  try {
    await db.pushLog.create({ data: { key } });
  } catch {
    return false; // already claimed — another sweep/cron is on it
  }
  await sendPushFiltered(payload, targets);
  return true;
}

/* ---------------- trigger helpers (called from sync / cron / top10) ---------------- */

/**
 * Broadcast a one-off confirmation push ("Clyle push works"). Used by the
 * opt-in toggle (instant proof the pipe is alive) and by verification.
 * `quiet` skips the emoji party for scripted smoke runs.
 */
export async function sendTestPush(quiet = false): Promise<{ ok: boolean; subs: number; sent: number; pruned: number }> {
  const r = await sendPushAll({
    t: quiet ? "Clyle test notification" : "🔔 Clyle push works!",
    b: quiet ? "If you can read this, Web Push is healthy." : "You'll get a ping the moment a new anime or episode drops.",
    tag: "clyle-test",
    url: "/",
  });
  return { ok: true, subs: r.sent + r.pruned, sent: r.sent, pruned: r.pruned };
}

function hoursFromNow(unixSec: number): string {
  const h = Math.round((unixSec - Date.now() / 1000) / 3600);
  if (h >= 48) return `${Math.round(h / 24)} days`;
  if (h >= 1.5) return `${h} hours`;
  return "less than an hour";
}

function episodeLabel(type: string | null): string {
  return (type ?? "TV").toUpperCase() === "MOVIE" ? "movie" : "episode";
}

/**
 * New-episode pushes for one sync result. Grouped per anime (one push even
 * when a sweep imported several episodes of the same show), capped at 6
 * animes per sweep so a backlog catch-up can't flood the lock screen.
 */
export async function notifySyncResult(result: { episodesAdded: number; animeAdded: number; newEpisodes: Array<{ malId: number; ep: number }>; newAnimeIds?: number[] }): Promise<void> {
  try {
    // ---- new episodes: the highest fresh number per anime is the headline
    const byAnime = new Map<number, number>();
    for (const n of result.newEpisodes) {
      const cur = byAnime.get(n.malId) ?? 0;
      if (n.ep > cur) byAnime.set(n.malId, n.ep);
    }
    const picks = [...byAnime.entries()].slice(0, 6);
    if (picks.length) {
      const rows = await db.anime.findMany({
        where: { malId: { in: picks.map(([malId]) => malId) } },
        select: { malId: true, title: true, titleEnglish: true, image: true, type: true },
      });
      const cat = new Map(rows.map((a) => [a.malId, a]));
      for (const [malId, ep] of picks) {
        const a = cat.get(malId);
        const title = a?.titleEnglish?.trim() || a?.title || `Anime ${malId}`;
        const isMovie = (a?.type ?? "").toLowerCase() === "movie";
        // per-anime opt-in: only devices that rang the bell on THIS anime's
        // details page get its episode drops ("that anime only")
        await pushOnce(`ep:${malId}:${ep}`, {
          t: isMovie ? `🎬 ${title} is out now` : `📺 ${title} — Episode ${ep} is out now`,
          b: `Fresh ${episodeLabel(a?.type ?? "TV")} just landed on Clyle. Tap to watch.`,
          tag: `new-ep-${malId}`,
          url: `/?open=${malId}`,
          img: a?.image ?? null,
        }, { onlyAnimeSubsOf: malId });
      }
    }

    // ---- new anime added to the catalog this sweep (cap 4)
    const newIds = (result.newAnimeIds ?? []).slice(0, 4);
    if (newIds.length) {
      const rows = await db.anime.findMany({
        where: { malId: { in: newIds } },
        select: { malId: true, title: true, titleEnglish: true, image: true, type: true },
      });
      for (const a of rows) {
        const title = a.titleEnglish?.trim() || a.title;
        const isMovie = (a.type ?? "").toLowerCase() === "movie";
        await pushOnce(`anime:${a.malId}`, {
          t: isMovie ? `🎬 New movie added: ${title}` : `✨ New series added: ${title}`,
          b: "Just joined the Clyle catalog — be the first to watch.",
          tag: `new-anime-${a.malId}`,
          url: `/?open=${a.malId}`,
          img: a.image ?? null,
        });
      }
    }
  } catch (err) {
    console.error("[push] notifySyncResult failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * ONE Top 10 push per day summarizing the most notable rank change(s) —
 * the bell carries the full feed; this is the lock-screen reminder.
 * `notable` = events inside the Top 10 window only (deep-chart churn at
 * ranks 11-50 stays bell-only, not push-worthy).
 */
export async function notifyTop10Changes(day: string, events: Array<{ type: string; rank: number | null; prevRank: number | null; title: string }>): Promise<void> {
  try {
    const notable = events.filter((e) => (e.rank != null && e.rank <= 10) || (e.prevRank != null && e.prevRank <= 10));
    if (!notable.length) return;
    const star = notable.find((e) => e.rank === 1) ?? notable[0];
    const verb =
      star.type === "enter"
        ? "entered the Top 10"
        : star.type === "up"
          ? `climbed to #${star.rank}`
          : star.type === "down"
            ? `fell to #${star.rank}`
            : "left the Top 10";
    const rest = notable.length - 1;
    await pushOnce(`top10:${day}`, {
      t: `🏆 ${star.title} ${verb}`,
      b: rest > 0 ? `Top 10 This Month just moved — plus ${rest} more change${rest > 1 ? "s" : ""}.` : "Top 10 This Month just moved. See what's #1 now.",
      tag: "top10-update",
      url: "/",
    });
  } catch (err) {
    console.error("[push] notifyTop10Changes failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Cron reminder: episodes airing within the next 24h — "drops in ~3 hours".
 * Deduped per (anime, episode number, air time), so a schedule change that
 * moves the air time re-reminds exactly once. Cap 8 per cron run.
 */
export async function notifyAiringSoon(): Promise<void> {
  try {
    const nowSec = Date.now() / 1000;
    const in24h = nowSec + 24 * 3600;
    const rows = await db.anime.findMany({
      where: { inCatalog: true, nextEpisodeAt: { gt: Math.floor(nowSec), lte: Math.ceil(in24h) } },
      select: { malId: true, title: true, titleEnglish: true, image: true, type: true, nextEpisodeAt: true, nextEpisodeNum: true },
      orderBy: { nextEpisodeAt: "asc" },
      take: 8,
    });
    for (const a of rows) {
      if (!a.nextEpisodeAt || !a.nextEpisodeNum) continue;
      // per-anime opt-in — same rule as episode drops: only devices that
      // subscribed to THIS anime get its reminder (checked BEFORE claiming
      // the PushLog key, so subscribing between crons still gets the ping)
      const watchers = await db.animeNotify.count({ where: { malId: a.malId } }).catch(() => 0);
      if (!watchers) continue;
      const title = a.titleEnglish?.trim() || a.title;
      const isMovie = (a.type ?? "").toLowerCase() === "movie";
      const when = hoursFromNow(a.nextEpisodeAt);
      await pushOnce(`soon:${a.malId}:${a.nextEpisodeNum}:${a.nextEpisodeAt}`, {
        t: isMovie
          ? `🎬 ${title} drops in ${when}`
          : `⏰ ${title} — Episode ${a.nextEpisodeNum} drops in ${when}`,
        b: "Set it up — it airs soon on Clyle.",
        tag: `soon-${a.malId}`,
        url: `/?open=${a.malId}`,
        img: a.image ?? null,
      }, { onlyAnimeSubsOf: a.malId });
    }
    if (rows.length) console.log(`[push] airing-soon reminders for ${rows.length} anime`);
  } catch (err) {
    console.error("[push] notifyAiringSoon failed:", err instanceof Error ? err.message : err);
  }
}
