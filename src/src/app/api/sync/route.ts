import { NextResponse, after } from "next/server";
import { db } from "@/lib/db";
import { syncCatalog, lastSync, syncInProgress } from "@/lib/sync";
import { prefetchSkipTimes } from "@/lib/skip-times";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Arrival-kick throttle: the app fires POST /api/sync on EVERY open (cold
 * open, returning home, PWA foreground). A full sweep holds this lambda for
 * tens of seconds and spends AniList/Jikan budget, so any sync newer than
 * this window (started, running, or finished) makes the next kick return
 * instantly instead — one arrival per window pays for the sweep, everyone
 * else in that window free-rides on its result.
 */
const KICK_THROTTLE_MS = 5 * 60_000;

/** GET /api/sync — status of the last sync. */
export async function GET() {
  const sync = await lastSync();
  return NextResponse.json({ ...sync, syncing: syncInProgress() });
}

/**
 * POST /api/sync — run a catalog sync NOW (new episodes + new season anime).
 *
 * Query params:
 *  - ?kick=1  arrival kick (app open / PWA foreground): starts the sweep
 *             fire-and-forget and returns immediately — the client never
 *             uses the result. Throttled to one sweep per window unless
 *             force=1 is also present.
 *  - ?force=1 bypass the throttle (the Latest tab's "Sync now" button —
 *             an explicit user request always really syncs).
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  const kick = url.searchParams.get("kick") === "1";

  if (!force) {
    const recent = await db.syncLog.findFirst({
      orderBy: { startedAt: "desc" },
      select: { startedAt: true },
    });
    if (recent && Date.now() - recent.startedAt.getTime() < KICK_THROTTLE_MS) {
      const sync = await lastSync();
      return NextResponse.json({
        ok: true,
        skipped: true,
        lastSync: sync.at,
        episodesAdded: 0,
        animeAdded: 0,
        syncing: syncInProgress(),
      });
    }
  }

  // arrival kick: start the sweep now, answer instantly, finish the work
  // (and the skip-time warm for whatever it imported) after the response
  if (kick) {
    const sweep = syncCatalog();
    after(async () => {
      try {
        const result = await sweep;
        if (result.newEpisodes.length) await prefetchSkipTimes(result.newEpisodes);
      } catch {
        /* background best-effort */
      }
    });
    return NextResponse.json({ ok: true, started: true, syncing: syncInProgress() });
  }

  const result = await syncCatalog();
  const sync = await lastSync();
  // newly imported episodes bring their skip intro/ending along: warm the
  // AniSkip cache in the background, after the response is flushed
  if (result.newEpisodes.length) after(() => prefetchSkipTimes(result.newEpisodes));
  return NextResponse.json({ ...result, lastSync: sync.at, syncing: syncInProgress() });
}
