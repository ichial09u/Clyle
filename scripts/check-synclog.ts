import { PrismaClient } from "@prisma/client";
const db = new PrismaClient({ datasources: { db: { url: "file:" + process.cwd() + "/db/custom.db" } } });
async function main() {
  const logs = await db.syncLog.findMany({ orderBy: { startedAt: "desc" }, take: 3 });
  for (const l of logs) console.log(JSON.stringify(l));
}
main().finally(() => db.$disconnect());
