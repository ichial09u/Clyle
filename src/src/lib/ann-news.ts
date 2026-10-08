import { db } from "@/lib/db";
import { harvest, flushNow, logNewsSent, logAnnSub } from "@/lib/global-log";
import { sendPushToEndpoints } from "@/lib/push";

/**
 * ANN News sweep — checks the AnimeNewsNetwork newsroom RSS against every
 * globally-tracked anime (AnnTrackSub) and pushes "news about YOUR anime" to
 * the devices that track it.
 *
 * Runs from TWO triggers: the daily Vercel cron (/api/ann-news — Hobby plans
 * only allow daily crons) and a LAZY hourly kick on organic home traffic
 * (/api/home fires it via after() when this instance's last sweep is >60m
 * old). Safe to run concurrently: every send is claim-first (PushLog key +
 * a `news` marker through the global log so instances that sweep later never
 * resend), and dead endpoints found while sending are pruned globally.
 * Never throws.
 */

/**
 * In-flight coalescing: a burst of /api/home requests fires N after()
 * callbacks — they all await ONE sweep instead of racing N RSS fetches.
 */
let sweepInFlight: Promise<unknown> | null = null;

export async function maybeRunAnnNewsSweep(): Promise<void> {
  try {
    if (sweepInFlight) {
      await sweepInFlight.catch(() => undefined);
      return;
    }
    // runAnnNewsSweep self-claims (60-min gap) — the old wrapper pre-claim
    // wrote annnews:lastsweep BEFORE the sweep, whose own throttle then read
    // that fresh timestamp and bailed: the hourly lazy kick was a no-op and
    // even the daily cron got throttled by traffic-refreshed timestamps.
    sweepInFlight = runAnnNewsSweep();
    try {
      await sweepInFlight;
    } finally {
      sweepInFlight = null;
    }
  } catch {
    /* background nicety — never break the caller */
  }
}

const SWEEP_MIN_GAP_MS = 60 * 60 * 1000;

export async function runAnnNewsSweep(): Promise<{
  ok: boolean;
  subs: number;
  items: number;
  matched: number;
  sent: number;
  note?: string;
}> {
  // move the 60-min claim INTO the sweep itself — the old split let a manual
  // GET /api/ann-news bypass the throttle entirely and force RSS + push
  // hammering at will. The claim is a compare-and-swap on the stored stamp so
  // concurrent instances (cron + lazy kick on another lambda) cannot both win.
  const stamp = new Date().toISOString();
  try {
    const meta = await db.globalMeta.findUnique({ where: { key: "annnews:lastsweep" } });
    if (meta && Date.now() - new Date(meta.value).getTime() < SWEEP_MIN_GAP_MS) {
      return { ok: true, subs: 0, items: 0, matched: 0, sent: 0, note: "swept within the last hour — throttled" };
    }
    if (meta) {
      // CAS: only the first writer whose read is still current proceeds
      const cas = await db.globalMeta.updateMany({
        where: { key: "annnews:lastsweep", value: meta.value },
        data: { value: stamp },
      });
      if (cas.count === 0) {
        return { ok: true, subs: 0, items: 0, matched: 0, sent: 0, note: "another instance claimed the sweep" };
      }
    } else {
      const created = await db.globalMeta
        .create({ data: { key: "annnews:lastsweep", value: stamp } })
        .catch(() => null);
      if (!created) {
        const re = await db.globalMeta.findUnique({ where: { key: "annnews:lastsweep" } });
        if (re && Date.now() - new Date(re.value).getTime() < SWEEP_MIN_GAP_MS) {
          return { ok: true, subs: 0, items: 0, matched: 0, sent: 0, note: "another instance claimed the sweep" };
        }
        await db.globalMeta.update({ where: { key: "annnews:lastsweep" }, data: { value: stamp } }).catch(() => undefined);
      }
    }
  } catch (err) {
    console.warn("[ann-news] claim failed:", err instanceof Error ? err.message : err);
  }

  try {
    return await sweepInner();
  } catch (err) {
    console.warn("[ann-news] sweep failed:", err instanceof Error ? err.message : err);
    return { ok: false, subs: 0, items: 0, matched: 0, sent: 0, note: err instanceof Error ? err.message : "sweep failed" };
  }
}

async function sweepInner(): Promise<{
  ok: boolean;
  subs: number;
  items: number;
  matched: number;
  sent: number;
  note?: string;
}> {
  await harvest(); // converge AnnTrackSub + PushSub + news markers first

  const subs = await db.annTrackSub.findMany({
    select: { endpoint: true, malId: true, annId: true, annName: true, title: true, image: true },
    take: 400,
  });
  if (!subs.length) {
    await flushNow();
    return { ok: true, subs: 0, items: 0, matched: 0, sent: 0, note: "nobody is tracking any anime yet" };
  }

  // group subscribers by the ANN title the news must mention
  const byName = new Map<string, { endpoints: Set<string>; malId: number; image: string | null }>();
  for (const s of subs) {
    const name = (s.annName ?? "").trim();
    if (name.length < 4) continue; // too short to match headlines safely
    const g = byName.get(name.toLowerCase());
    if (g) g.endpoints.add(s.endpoint);
    else byName.set(name.toLowerCase(), { endpoints: new Set([s.endpoint]), malId: s.malId, image: s.image });
  }
  if (!byName.size) {
    await flushNow();
    return { ok: true, subs: subs.length, items: 0, matched: 0, sent: 0, note: "no usable ANN titles" };
  }

  const rss = await fetchRss();
  if (!rss) {
    await flushNow();
    return { ok: true, subs: subs.length, items: 0, matched: 0, sent: 0, note: "ANN newsroom RSS unreachable" };
  }

  const items = parseRss(rss)
    // pubDate guard: a fresh instance must not re-push 2-day-old RSS entries
    // (the marker replay through the global log only covers ~12h)
    .filter((i) => {
      if (!i.publishedAt) return true; // no date — keep (claim dedupe still applies)
      const t = Date.parse(i.publishedAt);
      return !Number.isFinite(t) || t >= Date.now() - 25 * 60 * 60 * 1000;
    })
    .slice(0, 40);
  let matched = 0;
  let sent = 0;
  const dead = new Set<string>();

  for (const item of items) {
    const guid = item.guid || item.link;
    if (!guid) continue;
    const hay = `${item.title}\n${item.description}`.toLowerCase();
    for (const [nameKey, g] of byName) {
      if (!matchesTitle(nameKey, hay)) continue;
      const claim = `annnews:${simpleHash(guid)}:${g.malId}`;
      // claim-first: this instance and any future instance skip the same send
      try {
        await db.pushLog.create({ data: { key: claim } });
      } catch {
        continue; // already claimed here (or a marker came through the log)
      }
      // matched news also lands in the in-app bell feed (GET /api/ann-news)
      await rememberFeedItem({ guid, headline: item.title.slice(0, 200), link: item.link || "/", malId: g.malId, anime: titleCase(nameKey) });
      const res = await sendPushToEndpoints(
        {
          t: `ANN News — ${titleCase(nameKey)}`,
          b: item.title.slice(0, 200),
          url: item.link || "/",
          // per-anime tag: the shared "ann-news" tag let multiple matches in
          // one sweep REPLACE each other in the tray (last wins, earlier
          // news silently vanished) — distinct anime now stack separately
          tag: `ann-news-${g.malId}`,
          img: g.image,
        },
        g.endpoints,
      );
      sent += res.sent;
      for (const d of res.dead) dead.add(d);
      if (res.sent > 0 || res.dead.length > 0) {
        // delivered (or every endpoint is gone — nothing worth retrying):
        // other instances must not resend this one
        logNewsSent(claim); // other instances must not resend this one
      } else {
        // transient send failure — release the claim so the next window retries
        await db.pushLog.delete({ where: { key: claim } }).catch(() => undefined);
      }
      matched++;
    }
  }

  // prune endpoints the push service says are gone (locally + global log)
  for (const endpoint of dead) {
    const rows = await db.annTrackSub.findMany({ where: { endpoint }, select: { malId: true } }).catch(() => []);
    await db.annTrackSub.deleteMany({ where: { endpoint } }).catch(() => undefined);
    await db.pushSub.deleteMany({ where: { endpoint } }).catch(() => undefined);
    for (const r of rows) {
      // off-messages ignore the keys — other instances drop the same rows
      logAnnSub(endpoint, { p256dh: "pruned", auth: "pruned" }, { malId: r.malId, annId: null, annName: null, title: null, image: null }, false);
    }
  }

  await flushNow();
  return { ok: true, subs: subs.length, items: items.length, matched, sent };
}

/* ---------------- helpers ---------------- */

async function fetchRss(): Promise<string | null> {
  const urls = [
    "https://cdn.animenewsnetwork.com/newsroom/rss.xml?ann-edition=all",
    "https://www.animenewsnetwork.com/newsroom/rss.xml?ann-edition=all",
  ];
  for (const u of urls) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 12_000);
    try {
      const res = await fetch(u, {
        headers: { "User-Agent": "ClyleApp/1.0 (ann news tracker)", Accept: "application/rss+xml, application/xml, text/xml, */*" },
        signal: ac.signal,
        cache: "no-store",
      });
      if (!res.ok) continue;
      const text = await res.text();
      if (text.includes("<item>")) return text;
    } catch {
      /* try the next mirror */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

function pick(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  if (!m) return "";
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => {
      // bounds-checked decode — a malformed entity (&#999999999;) must not
      // throw a RangeError and kill the whole sweep
      const n = Number(d);
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
    })
    .replace(/\s+/g, " ")
    .trim();
}

function parseRss(xml: string): Array<{ title: string; link: string; guid: string; description: string; publishedAt: string }> {
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  return blocks.map((b) => ({
    title: pick(b, "title"),
    link: pick(b, "link"),
    guid: pick(b, "guid"),
    description: pick(b, "description"),
    publishedAt: pick(b, "pubDate"),
  }));
}

/* ---------------- in-app news feed (the bell's ANN News section) ---------------- */

export interface AnnNewsFeedItem {
  guid: string;
  headline: string;
  link: string;
  malId: number;
  anime: string;
  at: string;
}

const FEED_KEY = "annnews:feed";
const FEED_CAP = 30;

async function rememberFeedItem(item: Omit<AnnNewsFeedItem, "at">): Promise<void> {
  try {
    const row = await db.globalMeta.findUnique({ where: { key: FEED_KEY } });
    let feed: AnnNewsFeedItem[] = [];
    try {
      const parsed = JSON.parse(row?.value ?? "[]") as AnnNewsFeedItem[];
      if (Array.isArray(parsed)) feed = parsed;
    } catch {
      feed = [];
    }
    feed = feed.filter((f) => !(f.guid === item.guid && f.malId === item.malId));
    feed.unshift({ ...item, at: new Date().toISOString() });
    await db.globalMeta
      .upsert({
        where: { key: FEED_KEY },
        create: { key: FEED_KEY, value: JSON.stringify(feed.slice(0, FEED_CAP)) },
        update: { value: JSON.stringify(feed.slice(0, FEED_CAP)) },
      })
      .catch(() => undefined);
  } catch {
    /* feed is a nicety — never break the sweep */
  }
}

export async function annNewsFeed(): Promise<AnnNewsFeedItem[]> {
  try {
    const row = await db.globalMeta.findUnique({ where: { key: FEED_KEY } });
    const parsed = JSON.parse(row?.value ?? "[]") as AnnNewsFeedItem[];
    return Array.isArray(parsed) ? parsed.slice(0, FEED_CAP) : [];
  } catch {
    return [];
  }
}

/** word-boundary-ish headline match on the normalized ANN title */
/** loose comparable form — same normalization the ANN lookup route uses, so
 *  punctuation/accent variants ("Demon Slayer: …" vs "Demon Slayer …") match */
function normKey(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function matchesTitle(nameKey: string, rawHay: string): boolean {
  // normalize BOTH sides; word-boundary test on the folded forms
  const key = normKey(nameKey);
  const hay = normKey(rawHay);
  if (!key) return false;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^| )${escaped}( |$)`).test(hay);
}

function titleCase(nameKey: string): string {
  return nameKey.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
