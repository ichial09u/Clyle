import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
// error time distribution (hour buckets, UTC day)
const errs = await p.scoutFinding.findMany({ where: { status: "error" }, select: { detail: true, malId: true, createdAt: true, bot: true } });
const byHour = {};
for (const e of errs) {
  const k = e.createdAt.toISOString().slice(0, 13);
  byHour[k] = (byHour[k] || 0) + 1;
}
console.log("errors by UTC hour:");
Object.entries(byHour).sort().slice(-24).forEach(([k, v]) => console.log(`  ${k}:00  ${v}`));
// findings ok time distribution
const oks = await p.scoutFinding.findMany({ where: { status: "ok" }, select: { createdAt: true } });
const okByHour = {};
for (const e of oks) { const k = e.createdAt.toISOString().slice(0, 13); okByHour[k] = (okByHour[k] || 0) + 1; }
console.log("ok findings by UTC hour:"); Object.entries(okByHour).sort().slice(-10).forEach(([k, v]) => console.log(`  ${k}:00  ${v}`));
// bot distribution of errors
const byBot = {};
for (const e of errs) byBot[e.bot] = (byBot[e.bot] || 0) + 1;
console.log("errors by bot:", JSON.stringify(byBot));
await p.$disconnect();
