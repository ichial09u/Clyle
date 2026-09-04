/**
 * Per-episode, per-server DUB audio verdicts (the DAN DA DAN fix).
 *
 * Zoko/Kiwi sometimes ship a DUB entry whose VIDEO is a different encode —
 * so the runtime's byte-compare passes — but the muxed AUDIO is still the
 * original Japanese track. Only a decoded-audio comparison catches it, and
 * that needs ffmpeg, which serverless doesn't have. So the OFFLINE fleet
 * (local node + ffmpeg, optionally the z-ai ASR ear) measures the audio and
 * writes verdicts here; playback consults this table.
 *
 *   verdict "real" — the DUB entry's decoded audio differs from the SUB's
 *                    (ASR spot-checks heard English where applied)
 *   verdict "fake" — the DUB entry carries the same audio as the SUB under a
 *                    DUB label (Japanese audio masquerading as English)
 *
 * A "fake" verdict makes verifyRealDub answer false WITHOUT the network, so
 * the player's fallback chain lands on a real English backfill source
 * (SupaPlay / Megaplay buzz / megaplay-embed). Server-side only.
 */

import { db } from "@/lib/db";

export type DubAudioVerdict = "real" | "fake";

export async function getDubAudioVerdict(
  malId: number,
  ep: number,
  server: string,
): Promise<DubAudioVerdict | null> {
  try {
    const row = await db.dubAudio.findUnique({
      where: { malId_ep_server: { malId, ep, server } },
      select: { verdict: true },
    });
    if (row?.verdict === "real" || row?.verdict === "fake") return row.verdict;
    return null;
  } catch {
    return null; // table missing / db hiccup — never block playback on this
  }
}

/** Persist a fleet-measured verdict (upsert; keeps the latest method/detail). */
export async function storeDubAudioVerdict(
  malId: number,
  ep: number,
  server: string,
  verdict: DubAudioVerdict,
  method: "audio-md5" | "asr-en" = "audio-md5",
  detail?: string | null,
): Promise<void> {
  await db.dubAudio.upsert({
    where: { malId_ep_server: { malId, ep, server } },
    create: { malId, ep, server, verdict, method, detail: detail ?? null },
    update: { verdict, method, detail: detail ?? null, checkedAt: new Date() },
  });
}
