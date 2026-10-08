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

const SWEEP_MIN_GAP_MS = 60 * 60 * 1000;

export async function maybeRunAnnNewsSweep(): Promise<void> {
  try {
    const meta = await db.globalMeta.findUnique({ where: { key: "annnews:lastsweep" } });
    if (meta && Date.now() - new Date(meta.value).getTime() < SWEEP_MIN_GAP_MS) return;
    // optimistic claim — a failed sweep just waits for the next window
    await db.globalMeta
      .upsert({
        where: { key: "annnews:lastsweep" },
        create: { key: "annnews:lastsweep", value: new Date().toISOString() },
        update: { value: new Date().toISOString() },
      })
      .catch(() => undefined);
    await runAnnNewsSweep();
  } catch {
    /* background nicety — never break the caller */
  }
}

export async function runAnnNewsSweep(): Promise<{
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

  const items = parseRss(rss).slice(0, 40);
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
      const res = await sendPushToEndpoints(
        {
          t: `ANN News — ${titleCase(nameKey)}`,
          b: item.title.slice(0, 200),
          url: item.link || "/",
          tag: "ann-news",
          img: g.image,
        },
        g.endpoints,
      );
      sent += res.sent;
      for (const d of res.dead) dead.add(d);
      logNewsSent(claim); // other instances must not resend this one
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
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
}

function parseRss(xml: string): Array<{ title: string; link: string; guid: string; description: string }> {
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  return blocks.map((b) => ({
    title: pick(b, "title"),
    link: pick(b, "link"),
    guid: pick(b, "guid"),
    description: pick(b, "description"),
  }));
}

/** word-boundary-ish headline match on the normalized ANN title */
function matchesTitle(nameKey: string, hay: string): boolean {
  const escaped = nameKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(hay);
}

function titleCase(nameKey: string): string {
  return nameKey.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
