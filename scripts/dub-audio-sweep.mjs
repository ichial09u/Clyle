/**
 * Sweep the catalog for more audio-fake dubs (the Dandadan pattern):
 * top-N popular anime that claim a dub (hasDub/hasDubKiwi true), verify ep1
 * + a mid-season episode per server with the audio-MD5 probe, and write
 * DubAudio rows. Politeness: sequential with sleeps.
 *   node scripts/dub-audio-sweep.mjs [topN]
 */
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const TOPN = parseInt(process.argv[2] || "30", 10);

const candidates = await db.anime.findMany({
  where: { inCatalog: true, OR: [{ hasDub: true }, { hasDubKiwi: true }] },
  orderBy: { popularity: "asc" },
  take: TOPN,
  select: { malId: true, title: true, totalEpisodes: true, hasDub: true, hasDubKiwi: true },
});
console.log(`sweeping ${candidates.length} anime (ep1 + mid) — ${new Date().toISOString()}`);

for (const a of candidates) {
  const mid = a.totalEpisodes > 3 ? Math.floor(a.totalEpisodes / 2) : a.totalEpisodes;
  const eps = [...new Set([1, mid])].filter((n) => n > 0);
  for (const ep of eps) {
    for (const server of ["zoko", "kiwi"]) {
      const existing = await db.dubAudio.findUnique({ where: { malId_ep_server: { malId: a.malId, ep, server } } }).catch(() => null);
      if (existing) continue;
      try {
        const out = execSync(
          `node scripts/dub-audio-fleet.mjs --malId ${a.malId} --eps ${ep} --servers ${server}`,
          { encoding: "utf8", timeout: 240_000, cwd: "/home/z/my-project" },
        );
        const line = out.trim().split("\n").find((l) => l.startsWith(`ep${ep}-${server}`)) ?? "no-verdict";
        console.log(`[${a.title}] ${line}`);
      } catch (e) {
        console.log(`[${a.title}] ep${ep}-${server}: ERR ${String(e.message).slice(0, 80)}`);
      }
    }
  }
}
console.log("sweep done");
await db.$disconnect();
