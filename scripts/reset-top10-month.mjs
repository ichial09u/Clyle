import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
async function main() {
  const del = await db.top10Event.deleteMany({});
  console.log(`wiped ${del.count} events`);
  await db.top10Meta.deleteMany({ where: { key: { startsWith: "top10month" } } });
  console.log("cleared top10month snapshot + refreshedAt (fresh baseline on next refresh)");
  const cnt = await db.top10Event.count();
  console.log("events remaining:", cnt);
}
main().finally(() => db.$disconnect());
