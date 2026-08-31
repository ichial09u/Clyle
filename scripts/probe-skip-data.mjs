/**
 * Probe Zoko skip.intro/outro coverage across the catalog.
 * Hits the production /api/stream endpoint for a sample of animes and
 * reports how often Zoko's payload carries usable intro/outro timings.
 *
 * Usage: node scripts/probe-skip-data.mjs [baseUrl]
 *   baseUrl defaults to the production deployment.
 */

const BASE = process.argv[2] || "https://temporary-spry-granite-1f0h7ae.vercel.app";

// A representative slice of the catalog: long-runners, seasonal hits, movies-ish shorts.
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

const EPS = [1, 2];
const LANGS = ["sub", "dub"];

async function probe(malId, ep, lang) {
  const url = `${BASE}/api/stream?malId=${malId}&ep=${ep}&lang=${lang}&server=zoko`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json();
    return {
      ok: true,
      hasSrc: typeof data.src === "string" && data.src.length > 0,
      skip: data.skip ?? null,
    };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

function fmt(skip) {
  if (!skip) return "no-skip-field";
  const parts = [];
  if (skip.intro) parts.push(`intro ${skip.intro.start}-${skip.intro.end}`);
  if (skip.outro) parts.push(`outro ${skip.outro.start}-${skip.outro.end}`);
  return parts.length ? parts.join(" · ") : "skip-field-empty";
}

const rows = [];
let withIntro = 0, withOutro = 0, total = 0, failures = 0;

for (const [malId, title] of SAMPLE) {
  for (const ep of EPS) {
    for (const lang of LANGS) {
      total += 1;
      const r = await probe(malId, ep, lang);
      if (!r.ok || !r.hasSrc) {
        failures += 1;
        rows.push(`${title} ep${ep} ${lang}: STREAM FAIL ${r.status ?? r.error ?? "no src"}`);
        continue;
      }
      const hasI = !!r.skip?.intro && Number.isFinite(r.skip.intro.end);
      const hasO = !!r.skip?.outro && Number.isFinite(r.skip.outro.end);
      if (hasI) withIntro += 1;
      if (hasO) withOutro += 1;
      rows.push(`${title} ep${ep} ${lang}: ${fmt(r.skip)}`);
    }
  }
}

console.log(rows.join("\n"));
console.log("\n==== SUMMARY ====");
console.log(`total=${total} streamFail=${failures} withIntro=${withIntro} withOutro=${withOutro}`);
console.log(`intro coverage: ${((withIntro / total) * 100).toFixed(1)}%`);
console.log(`outro coverage: ${((withOutro / total) * 100).toFixed(1)}%`);
