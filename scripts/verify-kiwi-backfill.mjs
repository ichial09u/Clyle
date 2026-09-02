import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
async function main() {
  const t = await db.anime.count({ where: { inCatalog: true, hasDubKiwi: true } });
  const f = await db.anime.count({ where: { inCatalog: true, hasDubKiwi: false } });
  const n = await db.anime.count({ where: { inCatalog: true, hasDubKiwi: null } });
  console.log("hasDubKiwi true:", t, "| false:", f, "| null:", n);
  const op = await db.anime.findUnique({ where: { malId: 21 }, select: { hasDub: true, hasDubKiwi: true } });
  console.log("One Piece:", op);
}
main().finally(() => db.$disconnect());
