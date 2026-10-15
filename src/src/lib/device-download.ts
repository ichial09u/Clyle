"use client";

/**
 * device-download.ts — the shared engine behind Clyle's device downloads.
 *
 * Both the details-page DownloadPanel and the per-episode download sheet
 * ride on this: /api/stream resolve → either a progressive MP4 (WCO/LM2
 * encodes) or the proxied HLS variant walked segment-by-segment through our
 * own /api/stream/proxy (everything stays same-origin, so fetch + progress
 * just work) → Blob → `<a download>` save.
 *
 * Captions ride along with SUB: the resolved subtitle track is fetched,
 * converted VTT → SRT (the one sidecar format every phone + VLC understands)
 * and saved next to the video as "{name}.srt".
 */

export interface DlStreamPayload {
  src: string;
  subtitles?: Array<{ lang: string; label: string; src: string }>;
  heights?: number[];
  qualitySrcs?: Array<{ height: number; src: string }>;
  referer?: string;
  pk?: string;
  direct?: boolean;
  provider?: string;
  serverUsed?: string;
}

/** measured-average bitrates (Mbps) — the "why was the estimate huge" fix */
export const MBPS: Record<number, number> = { 1080: 1.8, 720: 1.0, 360: 0.5 };
export const LADDER = [1080, 720, 360];

export const estMB = (height: number, minutes: number) =>
  Math.round((MBPS[height] ?? 1.0) * 7.5 * Math.max(minutes || 24, 1));

export const proxied = (u: string, s?: DlStreamPayload) =>
  /^https?:/i.test(u) && !u.startsWith(location.origin)
    ? `/api/stream/proxy?u=${encodeURIComponent(u)}${s?.referer ? `&rf=${encodeURIComponent(s.referer)}` : ""}${s?.pk ? `&pk=${encodeURIComponent(s.pk)}` : ""}`
    : u;

export const safeName = (s: string) => s.replace(/[/\\:*?"<>|]+/g, " ").trim().slice(0, 80);

export const episodeFileBase = (title: string, ep: number) =>
  `${safeName(title)} EP${String(ep).padStart(2, "0")}`;

/** Nearest available rung on the resolved ladder for the wanted height. */
export const pickHeight = (want: number, available?: number[]) =>
  !available?.length
    ? want
    : available.reduce((b, h) => (Math.abs(h - want) < Math.abs(b - want) ? h : b), available[0]);

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Download one progressive MP4 (through the proxy for foreign hosts). */
export async function downloadDirect(
  src: string,
  s: DlStreamPayload,
  onBytes: (n: number) => void,
  signal: AbortSignal,
): Promise<Blob> {
  const res = await fetch(proxied(src, s), { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = await res.arrayBuffer();
    onBytes(buf.byteLength);
    return new Blob([buf]);
  }
  const parts: BlobPart[] = [];
  let acc = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    acc += value.length;
    onBytes(acc);
  }
  return new Blob(parts, { type: "video/mp4" });
}

/** Download one HLS variant: master → child playlist → segments → .ts blob. */
export async function downloadHls(
  playlistUrl: string,
  wantHeight: number,
  onBytes: (n: number) => void,
  signal: AbortSignal,
): Promise<{ blob: Blob; height: number }> {
  // the proxy hands us same-origin RELATIVE urls ("/api/stream/proxy?…") —
  // every `new URL(child, base)` below needs an absolute base to resolve
  // against, so pin everything to the document origin first (hls.js does
  // the same when it plays these playlists)
  const base = new URL(playlistUrl, location.href).toString();
  const masterRes = await fetch(base, { signal });
  if (!masterRes.ok) throw new Error(`playlist HTTP ${masterRes.status}`);
  const master = await masterRes.text();

  // pick the variant whose RESOLUTION height best matches the request
  const lines = master.split("\n").map((l) => l.trim());
  let childUrl: string | null = null;
  let best = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
    const m = /RESOLUTION=\d+x(\d+)/.exec(lines[i]);
    const h = m ? parseInt(m[1], 10) : 0;
    const uri = lines[i + 1] && !lines[i + 1].startsWith("#") ? lines[i + 1] : null;
    if (uri && (childUrl === null || Math.abs(h - wantHeight) < Math.abs(best - wantHeight))) {
      childUrl = uri;
      best = h;
    }
  }
  if (!childUrl) {
    // masterless playlist — the src itself is a media playlist
    childUrl = base;
    best = wantHeight;
  } else {
    childUrl = new URL(childUrl, base).toString();
  }

  const childRes = await fetch(childUrl, { signal });
  if (!childRes.ok) throw new Error(`variant HTTP ${childRes.status}`);
  const child = await childRes.text();

  const segs = child
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (!segs.length) throw new Error("no segments in playlist");

  const parts: BlobPart[] = [];
  let acc = 0;
  for (const seg of segs) {
    const segUrl = new URL(seg, childUrl).toString();
    const r = await fetch(segUrl, { signal });
    if (!r.ok) throw new Error(`segment HTTP ${r.status}`);
    const buf = await r.arrayBuffer();
    parts.push(buf);
    acc += buf.byteLength;
    onBytes(acc);
  }
  return { blob: new Blob(parts, { type: "video/mp2t" }), height: best };
}

/**
 * VTT → SRT. Strips the WEBVTT/NOTE headers, cue settings and inline tags,
 * converts the dot-milliseconds to SRT's comma form and numbers the cues.
 * Handles both 00:00:01.000 and 01:01.000 (no-hours) VTT timings.
 */
export function vttToSrt(vtt: string): string {
  const out: string[] = [];
  let idx = 0;
  const blocks = vtt.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (!lines.length) continue;
    if (/^WEBVTT/i.test(lines[0]) || /^NOTE\b/i.test(lines[0])) continue;
    const tIdx = lines.findIndex((l) => l.includes("-->"));
    if (tIdx === -1) continue;
    const m = /(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(
      lines[tIdx],
    );
    if (!m) continue;
    const stamp = (h: string | undefined, mm: string, ss: string, ms: string) =>
      `${h ? h.replace(":", "").padStart(2, "0") : "00"}:${mm.padStart(2, "0")}:${ss},${ms.padEnd(3, "0").slice(0, 3)}`;
    const start = stamp(m[1], m[2], m[3], m[4]);
    const end = stamp(m[5], m[6], m[7], m[8]);
    const text = lines
      .slice(tIdx + 1)
      .map((l) => l.replace(/<[^>]*>/g, "").trim())
      .filter(Boolean)
      .join("\n");
    if (!text) continue;
    idx += 1;
    out.push(`${idx}\n${start} --> ${end}\n${text}`);
  }
  return out.length ? out.join("\n\n") + "\n" : "";
}

/**
 * Fetch the resolved subtitle track and save it as a matching .srt sidecar.
 * If the track's VTT yields no convertible cues, the raw file is still saved
 * as .vtt — captions always ride along in SOME readable form. Returns false
 * only when nothing could be fetched at all.
 */
export async function saveSubtitleSrt(
  subUrl: string,
  s: DlStreamPayload,
  baseName: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const r = await fetch(proxied(subUrl, s), { signal });
    if (!r.ok) return false;
    const vtt = await r.text();
    const srt = vttToSrt(vtt);
    if (srt.trim()) {
      saveBlob(new Blob([srt], { type: "application/x-subrip" }), `${baseName}.srt`);
    } else {
      saveBlob(new Blob([vtt], { type: "text/vtt" }), `${baseName}.vtt`);
    }
    return true;
  } catch {
    return false;
  }
}
