import { PrismaClient } from "@prisma/client";
const db = new PrismaClient({ datasources: { db: { url: "file:" + process.cwd() + "/db/custom.db" } } });
async function main() {
  const rows: any[] = await db.$queryRawUnsafe(`SELECT * FROM DubAudio WHERE malId=40748 AND ep=1 LIMIT 10`).catch((e) => { console.log("query err", String(e).slice(0, 200)); return []; });
  console.log("DubAudio (40748 ep1):", JSON.stringify(rows, null, 1).slice(0, 1000) || "none");
  const cnt: any[] = await db.$queryRawUnsafe(`SELECT provider, verdict, COUNT(*) n FROM DubAudio GROUP BY provider, verdict LIMIT 20`).catch(() => []);
  console.log("verdict distribution:", JSON.stringify(cnt));
}
main().finally(() => db.$disconnect());
