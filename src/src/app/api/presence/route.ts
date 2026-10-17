import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET/POST /api/presence — the live "who's here right now" pulse.
 *
 * How it works:
 *   Every open client (site + Android app + PWA) sends a heartbeat POST
 *   every ~45s carrying its user id. The server keeps a sliding window of
 *   the sessions seen in the last 3 minutes and answers every POST with the
 *   current aggregate — total online + breakdown by PLATFORM (Android /
 *   iOS / Web, parsed from the User-Agent) and by REGION (country code from
 *   Vercel's x-vercel-ip-country header, when present).
 *
 * Why in-memory (globalThis) instead of the DB:
 *   Vercel lambda instances each get their own ephemeral /tmp copy of the
 *   SQLite file, and a cold start re-copies it from the packaged seed —
 *   presence rows written to disk would be invisible to other instances
 *   AND wiped on every cold start. A module-level map under the same warm
 *   instance is exactly as convergent, faster, and needs no migration.
 *   Render (single long-lived container) keeps the map for the container's
 *   lifetime, which is the ideal case. Sessions age out of the window, so
 *   a fresh instance repopulates within one heartbeat (~45s).
 *
 * Privacy: nothing identifying is stored beyond the rotating session key —
 * no IPs, no fingerprints; region is a country-level code, and only
 * aggregate counts ever leave this route.
 */

/** A session counts as "online" for this long after its last heartbeat. */
const WINDOW_MS = 3 * 60_000;

interface PresenceSession {
  lastSeen: number;
  region: string | null;
  platform: string;
}

// Survive dev-mode hot reloads (the same globalThis cache trick db.ts uses)
const g = globalThis as typeof globalThis & { __clylePresence?: Map<string, PresenceSession> };
const sessions: Map<string, PresenceSession> = g.__clylePresence ?? new Map();
g.__clylePresence = sessions;

/** Hard cap on tracked heartbeats — a uid flood cannot grow the map past this. */
const MAX_SESSIONS = 5_000;

function platformOf(ua: string): string {
  if (/android/i.test(ua)) return "Android"; // APK WebView + Android browsers
  if (/iphone|ipad|ipod/i.test(ua)) return "iOS";
  return "Web";
}

function aggregate() {
  const now = Date.now();
  const platforms = new Map<string, number>();
  const regions = new Map<string, number>();
  let online = 0;
  for (const [id, s] of sessions) {
    if (now - s.lastSeen > WINDOW_MS) {
      sessions.delete(id);
      continue;
    }
    online++;
    platforms.set(s.platform, (platforms.get(s.platform) ?? 0) + 1);
    const r = s.region ?? "?";
    regions.set(r, (regions.get(r) ?? 0) + 1);
  }
  const ranked = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  return {
    online,
    platforms: ranked(platforms).map(([name, count]) => ({ name, count })),
    regions: ranked(regions)
      .slice(0, 12)
      .map(([code, count]) => ({ code, count })),
    windowSec: Math.round(WINDOW_MS / 1000),
    ts: now,
  };
}

/**
 * POST /api/presence — heartbeat.
 * Body: { uid: string, leave?: boolean }
 * The response IS the live aggregate (the same warm instance that just
 * recorded the heartbeat answers it, so the caller always sees itself).
 */
export async function POST(req: Request) {
  let body: { uid?: unknown; leave?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* empty/invalid body falls through to bad params */
  }
  const uid = typeof body.uid === "string" ? body.uid.slice(0, 64) : "";
  if (!uid) {
    return NextResponse.json({ error: "bad params" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const region = req.headers.get("x-vercel-ip-country");
  const platform = platformOf(req.headers.get("user-agent") ?? "");
  if (body.leave === true) {
    sessions.delete(uid); // explicit pagehide beacon — drop immediately
  } else {
    // cap the map: a script POSTing random uids grew it without bound inside
    // the 3-min window (eviction only happens inside aggregate()). At the cap,
    // drop the OLDEST heartbeats first — real viewers re-heartbeat in seconds.
    if (!sessions.has(uid) && sessions.size >= MAX_SESSIONS) {
      const cutoff = Date.now() - 30_000;
      for (const [k, v] of sessions) {
        if (v.lastSeen < cutoff) sessions.delete(k);
        if (sessions.size < MAX_SESSIONS) break;
      }
      if (sessions.size >= MAX_SESSIONS) {
        // all fresh (flood): reject the new uid instead of growing further
        return NextResponse.json(aggregate(), { headers: { "Cache-Control": "no-store" } });
      }
    }
    sessions.set(uid, { lastSeen: Date.now(), region, platform });
  }
  return NextResponse.json(aggregate(), { headers: { "Cache-Control": "no-store" } });
}

/** GET /api/presence — read-only aggregate (debug / curl / dashboards). */
export async function GET() {
  return NextResponse.json(aggregate(), { headers: { "Cache-Control": "no-store" } });
}
