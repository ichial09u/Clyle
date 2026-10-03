/**
 * CORRECT the per-episode dub audio verdicts for Cyberpunk: Edgerunners
 * (42310): the zoko/kiwi "dub" streams carry JAPANESE audio under the DUB
 * label (fake dubs). The earlier audio-md5 segment compare produced false
 * "real" verdicts because the fake dub's encode differs from the sub's
 * (different MD5 != different language). ASR (z-ai) of the zoko ep1 dub
 * segment #22 transcribes Japanese dialogue — the kiwi server serves the
 * same zoko stream (resolvedFrom zokoanime.video).
 *
 * The real English dub is the VidTube chain (ASR: "Shopping or whatever the
 * hell she did all day..."). These corrected rows make resolveStream's
 * fast-path reject zoko/kiwi instantly and land the player on vidtube.
 *
 *   npx tsx scripts/edgerunners-dub-audio-correct.ts
 */
import { storeDubAudioVerdict } from "../src/lib/dub-audio";

async function main() {
  for (const ep of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    for (const server of ["zoko", "kiwi"] as const) {
      await storeDubAudioVerdict(
        42310,
        ep,
        server,
        "fake",
        "asr-en",
        "ASR 2026-09-07: zoko ep1 dub segment transcribes Japanese dialogue (fake dub under DUB label); kiwi serves the same zoko stream — corrected from the earlier audio-md5 false-positive",
      );
      console.log(`ep ${ep} ${server}: fake (asr-en) stored`);
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
