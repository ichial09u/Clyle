/**
 * Subtitle track selection.
 *
 * Zoko's payload metadata is broken: EVERY track is tagged lang:"en" (even
 * Arabic/Chinese/Spanish...), and English is often NOT first — e.g.
 * Fullmetal Alchemist: Brotherhood ep1 lists
 * [Arabic, Chinese, Chinese, Danish, Dutch, English(default), Finnish...].
 * The player used to play subtitles[0] blindly, so viewers got Arabic subs.
 *
 * pickSubtitleTrack picks what a viewer actually wants:
 *   1. a track labeled exactly "English"
 *   2. a track whose label contains "english" (e.g. "English [Full]")
 *   3. the source's own default flag
 *   4. the first track (old behavior, last resort)
 */

export interface SubTrack {
  lang: string;
  label: string;
  src: string;
  default?: boolean;
}

export function pickSubtitleTrack(subs?: SubTrack[] | null): SubTrack | undefined {
  if (!subs || subs.length === 0) return undefined;
  const norm = (s: string | undefined) => (s ?? "").trim().toLowerCase();
  const exact = subs.find((t) => norm(t.label) === "english");
  if (exact) return exact;
  const loose = subs.find((t) => /\benglish\b/.test(norm(t.label)));
  if (loose) return loose;
  const def = subs.find((t) => t.default === true);
  return def ?? subs[0];
}
