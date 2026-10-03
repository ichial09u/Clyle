const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
(async () => {
  const r = await db.anime.updateMany({ data: { hasDub: null } });
  console.log("wiped hasDub ->", r.count, "rows now null");
  const dist = await db.anime.groupBy({ by: ["hasDub"], _count: true });
  console.log(JSON.stringify(dist));
  await db.$disconnect();
})();
