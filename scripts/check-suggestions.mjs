/**
 * Offline sanity check for the v2 suggestion engine: score candidates for a
 * synthetic anchor (Detective Conan / Dr. Stone) through the same module the
 * route uses, via the local dev server's own code path.
 *
 * Usage: node scripts/check-suggestions.mjs
 * (hits localhost:3000 — dev server must be running)
 */
const uid = process.argv[2] || "suggestion-check-user";
const malId = process.argv[3]; // if given, seed a watch row for this anchor first

import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

async function main() {
  if (malId) {
    const anime = await db.anime.findUnique({ where: { malId: Number(malId) } });
    if (!anime) throw new Error("anchor not in catalog");
    await db.user.upsert({ where: { id: uid }, update: {}, create: { id: uid } });
    await db.watchProgress.upsert({
      where: { userId_malId_episode: { userId: uid, malId: Number(malId), episode: 1 } },
      update: { position: 300, updatedAt: new Date() },
      create: { userId: uid, malId: Number(malId), episode: 1, position: 300, duration: 1400, completed: false, lang: "sub", server: "zoko", title: anime.title, image: null },
    });
    console.log(`seeded anchor: ${anime.title} (${malId})`);
  }
  const res = await fetch(`http://localhost:3000/api/suggestions?userId=${uid}`);
  const j = await res.json();
  console.log("becauseOf:", j.becauseOf);
  for (const it of (j.items ?? []).slice(0, 10)) console.log(`  - ${it.title}`);
  await db.watchProgress.deleteMany({ where: { userId: uid } });
  await db.user.delete({ where: { id: uid } }).catch(() => undefined);
}

main().finally(() => process.exit(0));
