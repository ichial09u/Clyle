/**
 * Wipe session test data (users / progress / comments) from the dev SQLite DB
 * while keeping the seeded catalog intact. Run: node scripts/cleanup-test-data.mjs
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const users = await db.user.findMany({ select: { id: true, nickname: true } });
const comments = await db.comment.findMany({ select: { id: true, nickname: true, text: true } });
console.log(
  "users before:",
  users.length,
  users.map((u) => u.nickname).slice(0, 10),
);
console.log("comments before:", comments.length, comments.map((c) => c.text.slice(0, 40)));

const delC = await db.comment.deleteMany({});
const delP = await db.watchProgress.deleteMany({});
const delU = await db.user.deleteMany({});
console.log("deleted: comments", delC.count, "| progress", delP.count, "| users", delU.count);

const anime = await db.anime.count();
const eps = await db.episode.count();
console.log("catalog intact: anime", anime, "/ episodes", eps);

await db.$disconnect();
