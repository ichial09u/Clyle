/**
 * Skip-time lookup: OP/ED intervals for every catalog anime.
 *
 * Three tiers, best data wins:
 *   1. Zoko's own per-episode `skip` payload (frame-accurate, but rare —
 *      only some titles carry it)
 *   2. The vendored AniSkip community dataset (skip-times.data.json,
 *      built from aniskip's public dump — covers 42/43 catalog titles,
 *      3,290 OP entries, highest-vote row per episode)
 *   3. Per-anime consensus: openings are the SAME video across episodes,
 *      so episodes missing from the dump reuse the median interval of
 *      the anime's other episodes
 *
 * Server-side only (the dataset ships inside the server bundle).
 */

import skipDataset from "./skip-times.data.json";

export interface SkipInterval {
  start: number;
  end: number;
}

export interface SkipData {
  intro?: SkipInterval;
  outro?: SkipInterval;
  /** where the data came from — handy for debugging */
  source?: "zoko" | "aniskip";
}

type EpisodeEntry = { op?: [number, number]; ed?: [number, number] };
type Dataset = Record<string, Record<string, EpisodeEntry>>;

const data = skipDataset as unknown as Dataset;

/** median across an anime's known episodes, per type */
const consensusCache = new Map<string, { op?: [number, number]; ed?: [number, number] }>();

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function consensus(malId: number): { op?: [number, number]; ed?: [number, number] } {
  const key = String(malId);
  const hit = consensusCache.get(key);
  if (hit) return hit;

  const out: { op?: [number, number]; ed?: [number, number] } = {};
  const byEp = data[key];
  if (byEp) {
    for (const type of ["op", "ed"] as const) {
      const starts: number[] = [];
      const ends: number[] = [];
      for (const entry of Object.values(byEp)) {
        const iv = entry[type];
        if (iv) {
          starts.push(iv[0]);
          ends.push(iv[1]);
        }
      }
      const s = median(starts);
      const e = median(ends);
      if (s != null && e != null) out[type] = [s, e];
    }
  }
  consensusCache.set(key, out);
  return out;
}

/** Look up OP/ED intervals for one episode: exact entry, else per-anime consensus. */
export function lookupSkipTimes(malId: number, ep: number): { intro?: SkipInterval; outro?: SkipInterval } {
  const byEp = data[String(malId)];
  const entry = byEp?.[String(ep)] ?? consensus(malId);
  if (!entry) return {};
  const out: { intro?: SkipInterval; outro?: SkipInterval } = {};
  if (entry.op) out.intro = { start: entry.op[0], end: entry.op[1] };
  if (entry.ed) out.outro = { start: entry.ed[0], end: entry.ed[1] };
  return out;
}

function valid(iv: unknown): iv is SkipInterval {
  if (!iv || typeof iv !== "object") return false;
  const v = iv as SkipInterval;
  return Number.isFinite(v.start) && Number.isFinite(v.end) && v.end > v.start;
}

/**
 * Merge Zoko's native skip payload with the AniSkip dataset.
 * Zoko wins per-field (it is frame-accurate for its own encodes);
 * the dataset fills whatever Zoko left blank.
 */
export function withSkipData<T extends { skip?: SkipData }>(malId: number, ep: number, stream: T): T & { skip?: SkipData } {
  const zoko = stream.skip ?? {};
  const filled = lookupSkipTimes(malId, ep);

  const merged: SkipData = {};
  const intro = valid(zoko.intro) ? zoko.intro : valid(filled.intro) ? filled.intro : undefined;
  const outro = valid(zoko.outro) ? zoko.outro : valid(filled.outro) ? filled.outro : undefined;
  if (intro) merged.intro = intro;
  if (outro) merged.outro = outro;
  if (intro || outro) {
    merged.source = valid(zoko.intro) || valid(zoko.outro) ? "zoko" : "aniskip";
  }

  return { ...stream, skip: Object.keys(merged).length ? merged : undefined };
}
