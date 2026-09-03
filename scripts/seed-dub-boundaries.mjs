#!/usr/bin/env node
/**
 * One-shot boundary seeder: drains the prod backlog's dubprobe items with
 * modest concurrency, so the popular shows get per-episode DUB boundaries
 * immediately (the 24/7 fleet continues from there).
 *
 *   node scripts/seed-dub-boundaries.mjs [--minutes 8] [--concurrency 8]
 */
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const BASE = opt("prod", process.env.PROD_URL || "https://temporary-spry-granite-1f0h7ae.vercel.app");
const TOKEN = opt("token", process.env.SCOUT_TOKEN || "clyle-scout-v1");
const MINUTES = parseInt(opt("minutes", "8"), 10);
const CONC = Math.max(1, parseInt(opt("concurrency", "8"), 10) || 8);
const deadline = Date.now() + MINUTES * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = { true: 0, false: 0, transient: 0, errors: 0 };

async function probe(item) {
  const url = `${BASE}/api/bots/dub-probe?token=${encodeURIComponent(TOKEN)}&malId=${item.malId}&ep=${item.ep}&chain=${item.chain}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
    if (!res.ok) { stats.errors++; return; }
    const d = await res.json();
    if (d.verdict === null || d.verdict === undefined) stats.transient++;
    else stats[String(d.verdict)]++;
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${item.title} [${item.malId}] ep${item.ep} ${item.chain} -> ${d.verdict}`);
  } catch (err) {
    stats.errors++;
    console.log(`ERR ${item.title} [${item.malId}] ep${item.ep}: ${String(err).slice(0, 80)}`);
  }
}

async function main() {
  console.log(`seeding dub boundaries -> ${BASE} (budget ${MINUTES} min, ${CONC} lanes)`);
  let round = 0;
  while (Date.now() < deadline) {
    round++;
    const res = await fetch(`${BASE}/api/bots/intro-scout?token=${encodeURIComponent(TOKEN)}&limit=900`).catch(() => null);
    if (!res || !res.ok) { console.log(`backlog fetch failed (${res ? res.status : "network"})`); await sleep(10_000); continue; }
    const data = await res.json();
    const items = (data.backlog ?? []).filter((i) => i.kind === "dubprobe");
    if (!items.length) { console.log("round", round, ": no dubprobe items left — boundaries seeded as far as the backlog goes"); break; }
    console.log(`round ${round}: ${items.length} dubprobe items (of ${data.backlog.length} backlog)`);
    let idx = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONC, items.length) }, async () => {
        while (idx < items.length && Date.now() < deadline) {
          const item = items[idx++];
          await probe(item);
        }
      }),
    );
  }
  console.log(`done: ${JSON.stringify(stats)}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
