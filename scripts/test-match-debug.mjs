import { PrismaClient } from "@prisma/client";
import { analyzePlaylist } from "./lib/intro-detect.mjs";
const p = new PrismaClient();
const fs = await import("node:fs/promises");
const ref = await p.scoutRef.findUnique({ where: { malId: 2904 } });
const env = JSON.parse(ref.env);
const refInt = { start: ref.start, end: ref.end };
// replicate matchEnvelope pass1 with visibility
function slide(Cenv, label) {
  const WIN = 0.5;
  const len = refInt.end - refInt.start;
  let aS = Math.max(0, Math.round((refInt.start + len * 0.15) / WIN));
  let aE = Math.min(env.length, Math.round((refInt.end - len * 0.1) / WIN));
  const anchor = env.slice(aS, aE); const n = anchor.length;
  let best = null;
  const maxO = Cenv.length - aE;
  for (let o = -aS; o <= maxO; o++) {
    let sab=0, sa=0, sb=0, saa=0, sbb=0;
    for (let i = 0; i < n; i++) { const a=anchor[i], b=Cenv[o+aS+i]; sab+=a*b; sa+=a; sb+=b; saa+=a*a; sbb+=b*b; }
    const num = n*sab - sa*sb;
    const den = Math.sqrt((n*saa-sa*sa)*(n*sbb-sb*sb)+1e-9);
    const corr = num/den;
    if (!best || corr > best.corr) best = { o, corr };
  }
  console.log(`${label}: best corr=${best.corr.toFixed(3)} at offset=${best.o} -> OP ${((aS+best.o)*WIN).toFixed(1)}-${((aE+best.o)*WIN).toFixed(1)}s (anchor ${n} windows)`);
}
// ep3 (fresh)
const cg3 = JSON.parse(await fs.readFile("/tmp/cg3.json","utf8")).src;
const C3 = await analyzePlaylist(cg3, { log: () => {}, maxSec: 337, minSec: 337 });
slide(C3.env, "ep3");
// self-match sanity
slide(env, "self");
await p.$disconnect();
process.exit(0);
