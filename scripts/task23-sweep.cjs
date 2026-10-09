/**
 * One-time data sweep for Task 23:
 *   1. decode HTML entities already stored in Episode.titles (upstream shipped
 *      "I&#039;m"-style titles before cleanEpisodeTitle learned to decode),
 *   2. seed the fleet-proven FAKE-dub verdict for Pokémon Concierge (54633)
 *      ep1 on both servers — measured 2026-10-08: Zoko's DUB segments were
 *      byte-identical to the SUB (sha1 857141521ee5a2079d5f on both),
 *   3. trigger the new source-scoped fake-dub detection for eps 2-4 by
 *      resolving each once — a fake pins itself into DubAudio automatically.
 */
const { PrismaClient } = require("/home/z/my-project/src/node_modules/@prisma/client");

process.env.DATABASE_URL = `file:${__dirname}/../src/db/custom.db`;
const db = new PrismaClient();

function decodeEntities(s) {
  if (!s.includes("&")) return s;
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => safeCp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => safeCp(parseInt(d, 10)))
    .replace(/&(amp|quot|lt|gt|apos|nbsp|#39);/g, (_m, n) =>
      n === "amp" ? "&" : n === "quot" ? '"' : n === "lt" ? "<" : n === "gt" ? ">" : n === "nbsp" ? "\u00a0" : "'",
    );
}
function safeCp(cp) {
  if (!Number.isFinite(cp) || cp < 1 || cp > 0x10ffff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

async function main() {
  // ---- 1. entity sweep on stored episode titles
  const rows = await db.episode.findMany({ where: { title: { contains: "&" } }, select: { id: true, title: true } });
  let fixed = 0;
  for (const r of rows) {
    const t = decodeEntities(r.title);
    if (t !== r.title) {
      await db.episode.update({ where: { id: r.id }, data: { title: t } });
      fixed++;
    }
  }
  console.log(`[sweep] entity titles fixed: ${fixed}/${rows.length}`);

  // ---- 2. Concierge ep1: measured fake (byte-identical segments, 2026-10-08)
  for (const server of ["zoko", "kiwi"]) {
    await db.dubAudio
      .upsert({
        where: { malId_ep_server: { malId: 54633, ep: 1, server } },
        update: { verdict: "fake", method: "segment-digest", detail: "resolved dub byte-equal to sub (measured 2026-10-08)", checkedAt: new Date() },
        create: { malId: 54633, ep: 1, server, verdict: "fake", method: "segment-digest", detail: "resolved dub byte-equal to sub (measured 2026-10-08)" },
      })
      .catch(() => undefined);
  }
  console.log("[sweep] 54633 ep1 DubAudio fake rows seeded (zoko+kiwi)");

  // ---- 3. eps 2-4: one dub resolve each — a fake pins itself into DubAudio
  for (const ep of [2, 3, 4]) {
    try {
      const r = await fetch(`http://localhost:3000/api/stream?malId=54633&ep=${ep}&lang=dub&server=zoko&fresh=1`);
      const body = await r.json().catch(() => ({}));
      const row = await db.dubAudio.findUnique({ where: { malId_ep_server: { malId: 54633, ep, server: "zoko" } } });
      console.log(`[sweep] ep${ep}: HTTP ${r.status} ${body.provider ? "(" + body.provider + ")" : ""} | DubAudio: ${row ? row.verdict : "none"}`);
    } catch (e) {
      console.log(`[sweep] ep${ep}: resolve error ${e.message}`);
    }
  }

  // final state
  const verdicts = await db.dubAudio.findMany({ where: { malId: 54633 }, select: { ep: true, server: true, verdict: true } });
  console.log("[sweep] 54633 DubAudio:", JSON.stringify(verdicts));
}

main()
  .catch((e) => {
    console.error("[sweep] fatal:", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
