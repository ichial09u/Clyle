// One-off: read old (pre e41aee4ea) One Piece art URLs from the git-history
// copy of db/custom.db, and print current DB values for comparison.
import { PrismaClient } from "@prisma/client";

const old = new PrismaClient({
  datasources: { db: { url: "file:/home/z/my-project/scripts/tmp-oldart/custom.db" } },
});
const oldRow = await old.anime.findUnique({
  where: { malId: 21 },
  select: { malId: true, title: true, image: true, banner: true, logoUrl: true },
});
console.log("OLD (pre-fix):", JSON.stringify(oldRow, null, 2));
await old.$disconnect();

const cur = new PrismaClient();
const curRow = await cur.anime.findUnique({
  where: { malId: 21 },
  select: { malId: true, title: true, image: true, banner: true, logoUrl: true },
});
console.log("CURRENT:", JSON.stringify(curRow, null, 2));
await cur.$disconnect();
