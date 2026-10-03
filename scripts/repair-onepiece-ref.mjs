/**
 * ONE PIECE (malId 21) intro-skip repair, step 2 of the 2026-09-06 fix:
 *
 * The show's ScoutRef was a degenerate 4-step fingerprint (an old establish
 * bug), so EVERY fleet verify failed and carpeted 1,175 episodes with
 * button-suppressing nodetect rows — all purged by purge-scout-poison.mjs.
 *
 * Re-establishing now would pair the FIRST two episodes (1+2) and found the
 * reference on a 20-year-old opening nobody watches. The user watches the
 * current era (dub through ep 1155), so this nudge gates eps 1..1100 with
 * 8 h "establish" negative-cache findings (exactly what a failed pair writes)
 * — the backlog then pairs 1101+1102, which share the CURRENT opening
 * (dataset: op ~0-100 across eps 1101-1174). The ref expires the gate in 8 h
 * and the 24/7 fleet verifies the new episodes against it from then on.
 *
 * Run with: node scripts/repair-onepiece-ref.mjs
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const MAL_ID = 21;
const GATE_THROUGH = 1100;

// safety: only run while the ref is absent (mid-repair) and nothing was measured yet
const ref = await db.scoutRef.findUnique({ where: { malId: MAL_ID } });
if (ref) {
  console.log(`ref for ${MAL_ID} already exists (${JSON.parse(ref.env).length} steps) — nothing to gate`);
  process.exit(0);
}

const existing = await db.scoutFinding.findMany({
  where: { malId: MAL_ID, status: "establish", bot: "repair" },
  select: { ep: true },
});
const have = new Set(existing.map((r) => r.ep));
const rows = [];
for (let ep = 1; ep <= GATE_THROUGH; ep++) {
  if (have.has(ep)) continue;
  rows.push({
    bot: "repair",
    malId: MAL_ID,
    ep,
    title: "ONE PIECE",
    status: "establish",
    detail: "ref-repair gate: pre-era episode (current-OP establish pair must start at ep 1101+)",
  });
}
if (rows.length) await db.scoutFinding.createMany({ data: rows });
console.log(`gated ${rows.length} pre-era ONE PIECE episodes (8 h establish negative cache) — establish will pair 1101+`);
await db.$disconnect();
