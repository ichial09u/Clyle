/**
 * Dandadan S1 — authoritative per-episode chain probes via the fleet route
 * (probeDubChainEp: zoko -> kiwi -> supaplay -> megaplay -> anikoto-embed for
 * s1; kiwi -> zoko -> megaplay -> anikoto-embed for s2). Each definitive
 * verdict is persisted into DubProbe + the boundary fold by the route.
 *
 * Purpose: zoko/kiwi now appear to serve real dubs per-episode (verifyRealDub
 * segment-compare) even though the anime-level hasDub/hasDubKiwi verdicts are
 * stale false. This sweep rewrites the DubProbe truth for all 12 episodes on
 * both chains so the UI (dubMissing) and boundaries are consistent.
 *
 *   node scripts/dandadan-chain-probe.mjs
 */
const BASE = "http://localhost:3000";
const TOKEN = "clyle-scout-v1";
const MALID = 57334;
const TOTAL = 12;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(ep, chain) {
  const res = await fetch(`${BASE}/api/bots/dub-probe?token=${TOKEN}&malId=${MALID}&ep=${ep}&chain=${chain}`, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) return { ep, chain, verdict: `http-${res.status}` };
  const j = await res.json();
  return { ep, chain, verdict: j.verdict, boundaries: j.boundaries };
}

async function main() {
  const out = { s1: {}, s2: {} };
  for (let ep = 1; ep <= TOTAL; ep++) {
    for (const chain of ["s1", "s2"]) {
      const r = await probe(ep, chain);
      out[chain][ep] = r.verdict;
      console.log(`ep ${ep} ${chain}: ${JSON.stringify(r.verdict)} ${r.boundaries ? JSON.stringify(r.boundaries) : ""}`);
      await sleep(250);
    }
  }
  console.log("\nsummary:", JSON.stringify(out));
}

main().catch((e) => { console.error(e); process.exit(1); });
