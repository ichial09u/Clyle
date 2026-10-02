// TVmaze coverage probe for the problem shows
const q = async (u: string) => (await fetch(u, { signal: AbortSignal.timeout(10_000) })).json();

for (const [label, query] of [
  ["Mushoku Tensei", "mushoku tensei"],
  ["Clevatess", "clevatess"],
  ["LIAR GAME", "liar game"],
  ["One Piece 1999", "one piece"],
] as const) {
  const r = (await q(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`)) as Array<{ show: { id: number; name: string; premiered: string | null } }>;
  for (const { show } of r.slice(0, 3)) {
    console.log(`${label}: id=${show.id} "${show.name}" premiered=${show.premiered}`);
  }
}

// one full episode fetch for the original One Piece candidate + Mushoku
const onePiece = (await q(`https://api.tvmaze.com/search/shows?q=one%20piece`)) as Array<{ show: { id: number; premiered: string | null } }>;
const op1999 = onePiece.map((x) => x.show).find((s) => s.premiered?.startsWith("1999"));
if (op1999) {
  const eps = (await q(`https://api.tvmaze.com/shows/${op1999.id}/episodes?specials=0`)) as Array<{ season: number; number: number; name: string; airdate: string }>;
  console.log(`\nOP1999 id=${op1999.id} episodes=${eps.length}`);
  for (const e of eps.filter((e) => e.number >= 1178)) console.log(`  S${e.season}E${e.number} ${e.airdate} "${e.name}"`);
}
process.exit(0);
