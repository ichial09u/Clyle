import crypto from "node:crypto";

/**
 * Shared request guards for owner-only / abuse-sensitive API routes.
 *
 * Owner routes: /api/export (full user-data dump consumed by the local
 * merge/deploy scripts), /api/import (catalog writes), /api/sync?force=1
 * (bypasses the arrival throttle). The token lives in CLYLE_OWNER_TOKEN on
 * Vercel; the constant fallback keeps the local scripts working without env
 * setup — it is only readable from the private repo, never from the internet.
 */
export const OWNER_HEADER = "x-clyle-owner";

const OWNER_FALLBACK = "clyle-owner-4f8e2d1c9b7a6f3e";

export function isOwnerRequest(req: Request): boolean {
  const expected = process.env.CLYLE_OWNER_TOKEN || OWNER_FALLBACK;
  const got = req.headers.get(OWNER_HEADER) ?? "";
  if (!got || got.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * In-memory sliding-window rate limiter (per serverless instance — enough to
 * stop burst spam from a single client; the data itself is also capped).
 * Returns true when the action is ALLOWED.
 */
const buckets = new Map<string, number[]>();
let lastSweep = Date.now();

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  // opportunistic cleanup so the map cannot grow unbounded
  if (now - lastSweep > 60_000) {
    lastSweep = now;
    for (const [k, hits] of buckets) {
      const alive = hits.filter((t) => now - t < windowMs);
      if (alive.length === 0) buckets.delete(k);
      else buckets.set(k, alive);
    }
  }
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);
  return true;
}

/** Best-effort client identity for rate limiting: forwarded IP or "anon". */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  return fwd.split(",")[0].trim() || "anon";
}

/**
 * Scheduled-entrypoint gate (/api/cron, /api/cron-sync, /api/bots/tsa-cron).
 * Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` automatically once
 * the env var exists — so: secret set → the header is REQUIRED; secret unset
 * → the entrypoint stays open (local + Render behavior unchanged). Without
 * this anyone on the internet could stack the heal sweeps / segment probes
 * per request and burn the upstream budget.
 */
export function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!got || got.length !== secret.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(secret));
  } catch {
    return false;
  }
}
