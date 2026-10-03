/**
 * Store fresh per-episode dub audio verdicts for Cyberpunk: Edgerunners
 * (42310) into the DubAudio table. Verdicts were measured 2026-09-07 by
 * running verifyRealDub (zoko/kiwi payload fetch + sub-vs-dub segment
 * audio MD5 compare) for every episode on both servers.
 *
 *   true  -> verdict "real"  (real English dub served)
 *   false -> verdict "fake"  (not real English — fake or absent; routing
 *            effect is identical: that server falls through)
 *
 *   npx tsx scripts/edgerunners-dub-audio-store.ts
 */
import { storeDubAudioVerdict } from "../src/lib/dub-audio";

// measured 2026-09-07 via scripts/edgerunners-zoko-check.ts
const MEASURED: Array<{ ep: number; zoko: boolean; kiwi: boolean }> = [
  { ep: 1, zoko: true, kiwi: true },
  { ep: 2, zoko: true, kiwi: true },
  { ep: 3, zoko: true, kiwi: true },
  { ep: 4, zoko: true, kiwi: true },
  { ep: 5, zoko: true, kiwi: true },
  { ep: 6, zoko: false, kiwi: true },
  { ep: 7, zoko: true, kiwi: true },
  { ep: 8, zoko: true, kiwi: true },
  { ep: 9, zoko: true, kiwi: true },
  { ep: 10, zoko: false, kiwi: true },
];

async function main() {
  for (const m of MEASURED) {
    for (const [server, real] of [["zoko", m.zoko], ["kiwi", m.kiwi]] as const) {
      await storeDubAudioVerdict(42310, m.ep, server, real ? "real" : "fake", "audio-md5", real ? "real English dub (verifyRealDub segment compare 2026-09-07)" : "not real English — fake or absent (verifyRealDub 2026-09-07)");
      console.log(`ep ${m.ep} ${server}: ${real ? "real" : "fake"} stored`);
    }
  }
}
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
