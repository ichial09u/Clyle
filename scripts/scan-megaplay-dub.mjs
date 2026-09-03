#!/usr/bin/env node
/**
 * Scan animes with hasDub=false && hasDubKiwi=false and check which ones get
 * a REAL dub from flikhub/megaplay (seg- segment count in the dub variant).
 * Positive hits prove the /api/stream fallback chain end-to-end.
 */
import { readFileSync } from "node:fs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36";
const REFERER = "https://megaplay.buzz/";

async function segCount(masterUrl) {
  const headers = { "User-Agent": UA, Referer: REFERER };
  const m = await fetch(masterUrl, { headers, signal: AbortSignal.timeout(15000) });
  if (!m.ok) return null;
  const master = await m.text();
  const variant = master.split("\n").find((l) => l.trim() && !l.startsWith("#"));
  if (!variant) return 0;
  const v = await fetch(new URL(variant.trim(), masterUrl).href, { headers, signal: AbortSignal.timeout(15000) });
  if (!v.ok) return null;
  const text = await v.text();
  return text.split("\n").filter((l) => {
    const s = l.trim();
    return s && !s.startsWith("#") && /seg-\d+-/.test(s) && !/tiktokcdn\.com/.test(s);
  }).length;
}

// read malIds passed on argv
const ids = process.argv.slice(2).map(Number).filter(Number.isFinite);
for (const malId of ids) {
  try {
    const res = await fetch(`https://api.flikhub.net/megaplay?mal=${malId}&ep=1&type=dub`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      console.log(`${malId}: flikhub ${res.status}`);
      continue;
    }
    const json = await res.json();
    if (!json.m3u8) {
      console.log(`${malId}: no m3u8 (definitive no-dub)`);
      continue;
    }
    const n = await segCount(json.m3u8);
    console.log(`${malId}: m3u8 ok, real segments = ${n}${n >= 3 ? "  <-- REAL DUB" : "  (stub)"}`);
  } catch (e) {
    console.log(`${malId}: error ${e.message}`);
  }
}
