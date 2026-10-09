#!/usr/bin/env node
/**
 * Task 28 DB cleanup: drop the three source-dead South Park episode rows the
 * bot fleet proved unplayable (S23E10 pulled from WCO; both Post COVID
 * specials' files dead at the CDN). The grid derives numbers[] from these
 * rows, so deleting them removes the dead tiles.
 */
import { createRequire } from "node:module";

const require = createRequire("/home/z/my-project/src/index.js"); // resolve from src/node_modules
const { PrismaClient } = require("@prisma/client");

const db = new PrismaClient({ datasources: { db: { url: "file:/home/z/my-project/src/db/custom.db" } } });

const targets = [
  { animeId: 999923, number: 10 },
  { animeId: 999924, number: 3 },
  { animeId: 999924, number: 4 },
];
for (const t of targets) {
  const row = await db.episode.findUnique({ where: { animeId_number_lang: { ...t, lang: "sub" } }, select: { animeId: true, number: true, title: true } });
  const gone = await db.episode.deleteMany({ where: { ...t, lang: "sub" } });
  console.log(`deleted ${gone.count} row(s): ${t.animeId} E${t.number}${row ? ` (${row.title})` : ""}`);
}
for (const id of [999923, 999924]) {
  const rows = await db.episode.findMany({ where: { animeId: id, lang: "sub" }, orderBy: { number: "asc" }, select: { number: true } });
  console.log(`${id} remaining numbers: ${rows.map((r) => r.number).join(",")}`);
}
await db.$disconnect();
