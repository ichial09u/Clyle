/** Debug: replay logoFor for one title with full verdicts. Usage: node scripts/debug-logo-one.mjs 21 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";

const run = promisify(execFile);
const db = new PrismaClient();

// --- same primitives as seed-fanart-logos.mjs ---
const STOP = new Set(["the","a","an","of","no","ke","wa","ga","and","in","to","x","part","season","tv","special","ova","ona","movie","film","edition","collection","complete","final","new","ii","iii","iv","2","3","4","5"]);
function titleTokens(name) {
  const toks = name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const sig = toks.filter((t) => !STOP.has(t) && t.length > 1);
  return sig.length > 2 ? sig.slice(0, 2) : sig;
}
function captionMatches(caption, tokens) {
  const c = (caption ?? "").toLowerCase();
  if (!c) return false;
  if (tokens.length === 0) return /logo|wordmark|title/.test(c);
  return tokens.every((t) => c.includes(t));
}
function parseIHDR(buf) {
  if (buf.length < 26 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25] };
}
function hasTrns(buf) {
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    if (type === "tRNS") return true;
    if (type === "IDAT") return false;
    off += 12 + len;
  }
  return false;
}
function pngInfo(buf) {
  const ihdr = parseIHDR(buf);
  if (!ihdr) return null;
  const alpha = ihdr.colorType === 6 || ihdr.colorType === 4 || (ihdr.colorType === 3 && hasTrns(buf));
  return { ...ihdr, alpha, aspect: ihdr.width / ihdr.height };
}
async function inspectLogo(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { why: "http " + res.status };
    const size = Number(res.headers.get("content-length") ?? 0);
    if (size > 2_500_000) return { why: "too big" };
    const buf = Buffer.from(await res.arrayBuffer());
    const info = pngInfo(buf);
    if (!info) return { why: "not png" };
    if (!info.alpha) return { why: "no alpha ct=" + info.colorType };
    if (info.width < 300 || info.height < 80) return { why: "too small" };
    if (info.aspect < 1.1 || info.aspect > 8) return { why: "aspect " + info.aspect.toFixed(2) };
    return { ok: true, info };
  } catch (e) {
    return { why: e.message.slice(0, 40) };
  }
}

const malId = Number(process.argv[2] ?? "21");
const row = await db.anime.findUnique({ where: { malId } });
const name = (row.titleEnglish?.trim() || row.title).replace(/\s+/g, " ").trim();
const tokens = titleTokens(name);
console.log(`title=${name} tokens=${JSON.stringify(tokens)}`);

for (const q of [`${name} anime clearlogo transparent png`, `${name} logo png transparent background`, `${name} anime logo sticker png`]) {
  console.log(`\nQ: ${q}`);
  const { stdout } = await run("z-ai", ["image-search", "-q", q, "-c", "6", "--gl", "us"], { timeout: 170_000, maxBuffer: 8 * 1024 * 1024 });
  const j = JSON.parse(stdout.slice(stdout.indexOf("{")));
  for (const r of j.results ?? []) {
    const capOk = captionMatches(r.caption, tokens);
    const geo = await inspectLogo(r.original_url);
    console.log(` - cap=${capOk ? "Y" : "n"} geo=${geo.ok ? "Y " + geo.info.width + "x" + geo.info.height : "n(" + geo.why + ")"} ${r.original_url.slice(-28)}`);
    console.log(`   cap: ${(r.caption ?? "(none)").slice(0, 100)}`);
  }
}
await db.$disconnect();
