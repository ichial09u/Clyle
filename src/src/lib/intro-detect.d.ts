/** Typed surface of scripts/lib/intro-detect.mjs (copied to src/lib for bundling). */
export interface AnalyzeResult {
  status: string;
  env: number[];
  analyzedSec: number;
  wall: { start: number; end: number } | null;
  p95: number;
  detail?: string;
}
export interface EnvelopeMatch {
  start: number;
  end: number;
  quality: number;
}
export declare function analyzePlaylist(
  masterUrl: string,
  opts?: { headers?: Record<string, string>; log?: (s: string) => void; minSec?: number; maxSec?: number },
): Promise<AnalyzeResult>;
export declare function matchEnvelope(env: number[], refEnv: number[], refInt: { start: number; end: number }): EnvelopeMatch | null;
export declare function plausibleInterval(start: number, end: number): boolean;
