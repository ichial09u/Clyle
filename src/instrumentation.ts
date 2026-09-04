/**
 * Next.js instrumentation hook — runs once per server boot (local dev only).
 *
 * The 24/7 fleet (21 intro-scout bots + dub-probe workers, supervised by
 * scripts/scout-supervisor.sh) needs a long-lived host process. In this
 * environment detached background processes spawned from shells get reaped,
 * but the dev server survives — so the server itself bootstraps the fleet:
 *
 *   - skipped on Vercel (serverless can't host daemons; the fleet reports
 *     to prod over HTTP from here instead) and during build
 *   - pidfile-locked so hot reloads / route compiles never multiply it
 *   - the supervisor restarts the fleet if it ever dies
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.VERCEL === "1" || process.env.NEXT_PHASE === "phase-production-build") return;

  const { spawn } = await import("node:child_process");
  const { existsSync, readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
  const path = await import("node:path");

  try {
    const root = process.cwd();
    const lockDir = path.join(root, "db", "fleet");
    mkdirSync(lockDir, { recursive: true });
    const pidFile = path.join(lockDir, "supervisor.pid");

    // already running? (pidfile alive + still our supervisor)
    if (existsSync(pidFile)) {
      const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 0); // signal 0 = liveness probe
          console.log("[fleet] supervisor already running as pid", pid);
          return;
        } catch {
          // stale lock — reclaim it below
        }
      }
    }

    const log = path.join(root, "scripts", "scout-supervisor.log");
    const out = existsSync(log) ? await import("node:fs").then((fs) => fs.openSync(log, "a")) : await import("node:fs").then((fs) => fs.openSync(log, "w"));
    const child = spawn("bash", [path.join(root, "scripts", "scout-supervisor.sh")], {
      cwd: root,
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, PATH: process.env.PATH },
    });
    child.unref();
    writeFileSync(pidFile, String(child.pid), "utf8");
    console.log("[fleet] supervisor spawned as pid", child.pid, "->", log);
  } catch (err) {
    console.error("[fleet] bootstrap failed:", err instanceof Error ? err.message : err);
  }
}
