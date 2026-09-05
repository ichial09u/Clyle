/**
 * Next.js instrumentation hook — runs once per server boot (local dev only).
 *
 * ⚠️ Deliberately does NOT spawn the fleet anymore. History: this hook used
 * to bootstrap scout-supervisor.sh on every dev boot, and "one boot" turned
 * out to be "every hot reload / every route compile" — duplicate 21-lane
 * fleets (2×21 ffmpeg decodes ≈ 3.4 GB) piled up until the kernel OOM-killed
 * the dev server, whose restart spawned the fleet again: a perfect OOM spiral
 * that looked like random dev-server crashes.
 *
 * Fleet lifecycle is owned exclusively by scripts/fleet-watchdog-loop.sh
 * (idempotent, single-instance via pgrep, reaps duplicates). The dev server
 * restarts freely without ever multiplying bots.
 */
export async function register(): Promise<void> {
  // no fleet bootstrap here — the watchdog owns it
  if (process.env.VERCEL === "1") return;
}
