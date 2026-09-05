import { PrismaClient } from "@prisma/client";
import { analyzePlaylist, matchEnvelope, plausibleInterval } from "./lib/intro-detect.mjs";
const p = new PrismaClient();
const ref = await p.scoutRef.findUnique({ where: { malId: 2904 } });
if (!ref) { console.log("no ref for 2904"); process.exit(0); }
console.log(`ref: OP ${ref.start}-${ref.end}, env ${JSON.parse(ref.env).length} windows`);
const fs = await import("node:fs/promises");
const src = JSON.parse(await fs.readFile("/tmp/cg3.json","utf8")).src;
const span = Math.min(ref.end + 170, 400);
console.log(`verify feed span: ${span}s (OLD code fed ~10s)`);
const t0 = Date.now();
const C = await analyzePlaylist(src, { log: () => {}, maxSec: span, minSec: span });
console.log(`status=${C.status} analyzedSec=${C.analyzedSec.toFixed(0)} envLen=${C.env.length} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
if (C.status === "ok") {
  const env = JSON.parse(ref.env);
  const m = matchEnvelope(C.env, env, { start: ref.start, end: ref.end });
  console.log("match:", JSON.stringify(m), "plausible:", m ? plausibleInterval(m.start, m.end) : "-");
  if (m) console.log(`\nVERDICT: ${2904} ep3 -> opening ${m.start}-${m.end} (q=${m.quality}) ✅ verify pipeline FIXED`);
} else console.log("detail:", C.detail);
await p.$disconnect();
