/**
 * Ground-truth check: does Zoko/Kiwi actually serve a REAL dub per episode
 * for Cyberpunk: Edgerunners (42310)? Runs verifyRealDub directly (bypasses
 * the anime-level pre-gate that the stream route uses) and prints one row
 * per (ep, server): true = real English dub, false = definitively absent,
 * null = transient.
 *
 *   npx tsx scripts/edgerunners-zoko-check.ts
 */
import { verifyRealDub } from "../src/lib/zoko-stream";

async function main() {
  const eps = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const servers: Array<"zoko" | "kiwi"> = ["zoko", "kiwi"];
  for (const ep of eps) {
    const cells: string[] = [];
    for (const s of servers) {
      const t0 = Date.now();
      const v = await verifyRealDub(42310, ep, s).catch((e) => {
        console.error(`  ep${ep} ${s} threw:`, e instanceof Error ? e.message : e);
        return null;
      });
      cells.push(`${s}=${v === null ? "null" : v} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }
    console.log(`ep ${ep}: ${cells.join("  ")}`);
  }
}
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
