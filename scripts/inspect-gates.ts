import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient({ datasources: { db: { url: "file:" + process.cwd() + "/db/custom.db" } } });
async function main() {
  // dub audio verdict table?
  const tables = await db.$queryRawUnsafe<{ name: string }[]>(`SELECT name FROM sqlite_master WHERE type='table'`).catch(() => []);
  console.log("tables:", tables.map(t => t.name).join(", "));
  const dt = tables.find(t => /dub/i.test(t.name));
  if (dt) {
    const rows: any[] = await db.$queryRawUnsafe(`SELECT * FROM "${dt.name}" WHERE "malId"=40748 OR "mal_id"=40748 LIMIT 8`).catch(() => []);
    console.log("dub rows for 40748:", JSON.stringify(rows, null, 1).slice(0, 1200));
  }
  // animegg watch streams from disk cache
  const DIR = join(process.cwd(), "db", "anivexa-cache");
  const p = join(DIR, createHash("sha1").update("watch:animegg:113415:dub:1").digest("hex").slice(0, 24) + ".json");
  try {
    const e = JSON.parse(readFileSync(p, "utf8"));
    console.log("animegg streams:", JSON.stringify(e.data, null, 1).slice(0, 900));
  } catch (err) { console.log("watch cache read failed:", err); }
}
main().finally(() => db.$disconnect());
