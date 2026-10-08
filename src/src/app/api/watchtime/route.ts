import { NextResponse, after } from "next/server";
import { db } from "@/lib/db";
import { lite } from "@/lib/serialize";
import type { AnimeLite } from "@/lib/types";
import { streaksForDay } from "@/lib/top10";
import { harvest, logWatchDelta, flushNow } from "@/lib/global-log";

export const dynamic = "force-dynamic";

/**
 * In-app watch time — accumulated playback seconds per (day, anime).
 *
 * This fed the original "Top 10 Today" rail; the rail now ranks by TMDB
 * popularity (see /api/top10 + top10-month.ts) and the bell carries
 * rank-change events instead of watch-time enter/leave events. The endpoint
 * still records + serves watch seconds (profile stats, history).
 */
interface WatchTimeBody {
  userId?: string;
  day?: string;
  malId?: number;
  delta?: number;
  title?: string;
  image?: string | null;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const day = sp.get("day") ?? new Date().toISOString().slice(0, 10);
  const limit = Math.min(25, Math.max(1, parseInt(sp.get("limit") ?? "10", 10) || 10));
  const all = sp.get("all") === "1";
  if (!all && !DAY_RE.test(day)) {
    return NextResponse.json({ error: "bad day" }, { status: 400 });
  }

  let rows: Array<{ malId: number; seconds: number; title: string | null; image: string | null }>;
  if (all) {
    // ALL-TIME ranking across every viewer (site + app combined) — this feeds
    // the home "Most Watched" rail, which must show REAL global results, not
    // a per-day or per-device slice. The smoke-bot scratch day is excluded.
    // Harvest first: replay every OTHER instance's watch deltas from the
    // global log into this instance's SQLite, so the aggregate below is the
    // SAME on every instance (identical list for app + site, everywhere).
    await harvest();
    const grouped = await db.watchStat.groupBy({
      by: ["malId"],
      where: { day: { not: "1970-01-01" } },
      _sum: { seconds: true, },
      orderBy: { _sum: { seconds: "desc" } },
      take: limit,
    });
    rows = grouped.map((g) => ({ malId: g.malId, seconds: g._sum.seconds ?? 0, title: null, image: null }));
  } else {
    const found = await db.watchStat.findMany({
      where: { day },
      orderBy: { seconds: "desc" },
      take: limit,
    });
    rows = found.map((r) => ({ malId: r.malId, seconds: r.seconds, title: r.title, image: r.image }));
  }

  // Notifications no longer ride watch-time (rank-change events come from the
  // TMDB-popularity Top 10 now); the streak metadata below stays for the API.

  // full catalog objects where we have the anime locally; otherwise fall back
  // to the title/poster snapshots the player sessions left behind
  const ids = rows.map((r) => r.malId);
  const catalog = await db.anime.findMany({ where: { malId: { in: ids } } });
  const cat = new Map(catalog.map((a) => [a.malId, lite(a)]));

  const items = rows.map((r) => {
    const l: AnimeLite | undefined = cat.get(r.malId);
    const base: AnimeLite =
      l ?? {
        malId: r.malId,
        title: r.title || `Anime ${r.malId}`,
        titleEnglish: null,
        image: r.image ?? null,
        banner: null,
        synopsis: null,
        type: null,
        ratingShort: null,
        status: null,
        airing: false,
        season: null,
        year: null,
        durationMin: null,
        score: null,
        rank: null,
        popularity: null,
        totalEpisodes: 0,
        nextEpisodeAt: null,
        nextEpisodeNum: null,
        genres: [],
        inCatalog: false,
        source: "snapshot",
      };
    return { ...base, malId: r.malId, seconds: r.seconds, image: base.image ?? r.image ?? null };
  });

  // Streak metadata: consecutive days in the Top 10 -> isNew (first day).
  // weeksInTop10 stays in the payload for API consumers, but per product
  // decision the duration is only surfaced when an anime LEAVES the Top 10
  // (stored on the leave notification, starting at 0 weeks).
  // Skipped for the all-time rail: the 60s home poll doesn't display streaks,
  // so computing per-day Top-10s on every poll was pure waste.
  const enriched = all
    ? items
    : await (async () => {
        const streaks = await streaksForDay(day, items.map((i) => i.malId));
        return items.map((it) => {
          const streak = streaks.get(it.malId) ?? 1;
          return { ...it, streakDays: streak, isNew: streak <= 1, weeksInTop10: Math.floor(streak / 7) };
        });
      })();

  return NextResponse.json({ day, items: enriched }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  let b: WatchTimeBody;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const malId = Number(b.malId);
  let day = (b.day ?? "").trim();
  // clamp: heartbeats arrive ~10s apart; 120s ceiling absorbs throttled
  // background tabs without letting a wild clock inject hours in one POST
  const delta = Math.round(Number(b.delta));

  if (!Number.isFinite(malId) || !DAY_RE.test(day) || !Number.isFinite(delta)) {
    return NextResponse.json({ error: "bad params" }, { status: 400 });
  }
  // reject days outside [today-7, today] — unbounded distinct days let a
  // scripted client fabricate arbitrary backdated ranking rows
  {
    const today = new Date().toISOString().slice(0, 10);
    const min = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    if (day > today || day < min) day = today;
  }
  if (delta < 1) {
    return NextResponse.json({ ok: true, skipped: true });
  }
  const inc = Math.min(delta, 120);

  const title = typeof b.title === "string" && b.title.trim() ? b.title.trim().slice(0, 200) : null;
  const image = typeof b.image === "string" && b.image.length <= 2000 ? b.image : null;

  await db.watchStat.upsert({
    where: { day_malId: { day, malId } },
    update: {
      seconds: { increment: inc },
      ...(title ? { title } : {}),
      ...(image ? { image } : {}),
    },
    create: { day, malId, seconds: inc, title, image },
  });

  // ALSO append to the global log (coalesced) so every other instance's
  // "Most Watched" aggregate converges on this watch within ~seconds.
  // after(): the 90s coalescing flush used to die with a frozen lambda right
  // after a beacon — wrapping keeps the response instant AND the flush alive.
  logWatchDelta(day, malId, inc, title, image);
  after(() => flushNow());

  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
