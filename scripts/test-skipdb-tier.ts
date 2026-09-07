/**
 * One-off: verify the SkipDB fill tier serves through the exact functions
 * the player and audit use. Run: bun scripts/test-skipdb-tier.ts
 */
import { skipCoverage, skipDbIntervals, withSkipDataLive } from "../src/lib/skip-times";
import { db } from "../src/lib/db";

const SAMPLES: Array<{ malId: number; title: string; eps: number[] }> = [
  { malId: 11061, title: "HxH (2011)", eps: [1, 5, 100] }, // skipdb-only per census
  { malId: 136, title: "HxH (1999)", eps: [1, 30] },
  { malId: 2904, title: "Code Geass R2", eps: [1, 12] },
  { malId: 52034, title: "Oshi no Ko", eps: [1, 5] },
  { malId: 16498, title: "AoT S1", eps: [1, 10] },
  { malId: 1735, title: "Naruto Shippuden", eps: [1, 50] },
  { malId: 52991, title: "Frieren (aniskip HAS this — must NOT flip to skipdb)", eps: [1] },
  { malId: 21, title: "One Piece (army/scout territory)", eps: [1, 800] },
];

async function main() {
  for (const s of SAMPLES) {
    for (const ep of s.eps) {
      const sdb = await skipDbIntervals(s.malId, ep);
      const cov = await skipCoverage(s.malId, ep, {});
      const merged = await withSkipDataLive(s.malId, ep, {}, { episodeLengthMin: 24 });
      const skip = (merged as { skip?: { intro?: { start: number; end: number }; source?: string } }).skip;
      console.log(
        `${s.title} ep${ep}: skipdb=[${sdb?.op ? `${sdb.op.start}-${sdb.op.end}` : "-"}] ` +
          `covSrc=${cov?.source ?? "none"} playerSrc=${skip?.source ?? "none"} ` +
          `intro=${skip?.intro ? `${skip.intro.start}-${skip.intro.end}` : "none"}`,
      );
    }
  }
  const total = await db.skipDbFill.count();
  console.log(`\nSkipDbFill rows in db: ${total}`);
  await db.$disconnect();
}
main();
