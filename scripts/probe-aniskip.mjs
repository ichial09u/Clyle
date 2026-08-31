/**
 * Probe AniSkip (https://aniskip.dev) coverage for the catalog sample.
 * AniSkip aggregates community-verified OP/ED timings keyed by MAL id.
 *
 * Usage: node scripts/probe-aniskip.mjs
 */

const SAMPLE = [
  [21, "One Piece"],
  [34572, "Black Clover"],
  [31240, "Re:Zero"],
  [39535, "Mushoku Tensei"],
  [16498, "AoT"],
  [1535, "Death Note"],
  [5114, "FMA:B"],
  [30276, "One Punch Man"],
  [11061, "HxH 2011"],
  [6702, "Fairy Tail"],
  [20, "Naruto"],
  [1735, "Shippuuden"],
  [31964, "MHA"],
  [9253, "Steins;Gate"],
  [14719, "JoJo 2012"],
  [38000, "Kimetsu no Yaiba"],
  [40748, "JJK"],
  [50265, "Spy x Family"],
  [52991, "Frieren"],
  [44511, "Chainsaw Man"],
];

async function probe(malId, ep) {
  const url = `https://api.aniskip.com/v2/search/episodes/${malId}?episodeNumber=${ep}&types=op&types=ed`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json();
    if (!data.found || !Array.isArray(data.results)) return { ok: true, found: false };
    const op = data.results.find((r) => r.type === "op" && r.interval);
    const ed = data.results.find((r) => r.type === "ed" && r.interval);
    return {
      ok: true,
      found: !!(op || ed),
      op: op?.interval ?? null,
      ed: ed?.interval ?? null,
    };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

const rows = [];
let withOp = 0, total = 0, fails = 0;

for (const [malId, title] of SAMPLE) {
  for (const ep of [1, 2]) {
    total += 1;
    const r = await probe(malId, ep);
    if (!r.ok) {
      fails += 1;
      rows.push(`${title} ep${ep}: ERROR ${r.status ?? r.error}`);
      continue;
    }
    if (!r.found) {
      rows.push(`${title} ep${ep}: not found`);
      continue;
    }
    if (r.op) withOp += 1;
    rows.push(
      `${title} ep${ep}: op ${r.op ? `${r.op.startTime}-${r.op.endTime}` : "-"} · ed ${r.ed ? `${r.ed.startTime}-${r.ed.endTime}` : "-"}`,
    );
    // be polite to the free API
    await new Promise((s) => setTimeout(s, 350));
  }
}

console.log(rows.join("\n"));
console.log("\n==== SUMMARY ====");
console.log(`total=${total} errors=${fails} withOp=${withOp}`);
console.log(`OP coverage: ${((withOp / total) * 100).toFixed(1)}%`);
