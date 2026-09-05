import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const errs = await p.scoutFinding.findMany({ where: { status: { in: ["error", "nodetect"] }, createdAt: { gte: new Date(Date.now() - 20 * 60_000) } }, select: { status: true, detail: true } });
const buckets = {};
for (const e of errs) { const k = `${e.status}: ${(e.detail||"").slice(0,50).replace(/fed=\d+s/g,"fed=Ns").replace(/q=[\d.]+/g,"q=X")}`; buckets[k]=(buckets[k]||0)+1; }
Object.entries(buckets).sort((a,b)=>b[1]-a[1]).slice(0,10).forEach(([k,v])=>console.log(` ${v}  ${k}`));
await p.$disconnect(); process.exit(0);
