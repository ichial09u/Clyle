// Prove prod WatchProgress ephemerality: POST a unique row, then GET it
// repeatedly. If prod's SQLite is on the lambda's ephemeral FS, reads will
// flip between instances: some see the row, some don't, and it eventually
// "disappears".
const base = "https://temporary-spry-granite-1f0h7ae.vercel.app";
const userId = "ephemeral-test-" + Date.now().toString(36);
const malId = 21;

const post = await fetch(base + "/api/progress", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ userId, malId, episode: 999, position: 100, duration: 1400, lang: "sub", server: "zoko", resume: true }),
});
console.log("POST:", post.status, await post.text());

const check = async (label) => {
  const t0 = Date.now();
  const r = await fetch(base + `/api/continue?userId=${userId}`);
  const vcid = r.headers.get("x-vercel-id") || "?";
  const d = await r.json();
  console.log(`${label}: items=${d.items.length} x-vercel-id=${vcid} (${Date.now() - t0}ms)`);
  return d.items.length;
};

for (let i = 0; i < 10; i++) {
  await check(`t+${i * 20}s`);
  if (i < 9) await new Promise((r) => setTimeout(r, 20000));
}
console.log("userId used:", userId);
