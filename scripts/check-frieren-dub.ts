import { PrismaClient } from "@prisma/client";
const db = new PrismaClient({ datasources: { db: { url: "file:" + process.cwd() + "/db/custom.db" } } });
async function main() {
  const a = await db.anime.findUnique({ where: { malId: 52991 }, select: { title: true, hasDub: true, hasDubKiwi: true, hasDubMega: true } });
  console.log("Frieren dub flags:", JSON.stringify(a));
}
main().finally(() => db.$disconnect());
