import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { lite } from "@/lib/serialize";
import type { AnimeLite } from "@/lib/types";
import {
  isCurrentishTop10Day,
  sealTop10Days,
  streaksForDay,
  touchTop10EnterEvents,
} from "@/lib/top10";

export const dynamic = "force-dynamic";

/**
 * In-app watch time — the data behind "Top 10 Today".
 *
 * POST /api/watchtime { userId?, malId, day, delta, title?, image? }
 *   -> accumulates `delta` seconds of REAL playback onto the (day, malId) row.
 *      The rail stays empty until the first delta arrives, then ranks purely
 *      by how long people actually watch.
 *
 * GET /api/watchtime?day=YYYY-MM-DD&limit=10
 *   -> the day's most-watched anime as full lite objects (+ seconds), so the
 *      Home rail can tap through to details exactly like every other row.
 *      Catalog titles/posters are preferred over the player snapshots
 *      (fresh art even if MAL re-renders an image).
 *
 * `day` is the viewer's LOCAL calendar day so "today" matches their timezone;
 * every device can contribute to slightly different day buckets, which is the
 * friendliest interpretation of "Top 10 Today" for a global audience.
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
  if (!DAY_RE.test(day)) {
    return NextResponse.json({ error: "bad day" }, { status: 400 });
  }

  const rows = await db.watchStat.findMany({
    where: { day },
    orderBy: { seconds: "desc" },
    take: limit,
  });

  // Notifications + streaks ride the app's normal rail fetches (Home asks for
  // a current day; smoke probes on scratch days skip the event machinery).
  const currentish = isCurrentishTop10Day(day);
  if (currentish) {
    await sealTop10Days(); // first real request of a new day publishes yesterday
    await touchTop10EnterEvents(day); // live "entered" while the day fills up
  }

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
  const streaks = await streaksForDay(day, items.map((i) => i.malId));
  const enriched = items.map((it) => {
    const streak = streaks.get(it.malId) ?? 1;
    return { ...it, streakDays: streak, isNew: streak <= 1, weeksInTop10: Math.floor(streak / 7) };
  });

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
  const day = (b.day ?? "").trim();
  // clamp: heartbeats arrive ~10s apart; 120s ceiling absorbs throttled
  // background tabs without letting a wild clock inject hours in one POST
  const delta = Math.round(Number(b.delta));

  if (!Number.isFinite(malId) || !DAY_RE.test(day) || !Number.isFinite(delta)) {
    return NextResponse.json({ error: "bad params" }, { status: 400 });
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

  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
