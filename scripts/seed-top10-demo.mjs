/**
 * Seeds a realistic Top 10 notification demo state for browser E2E:
 *  - One Piece (21) in the Top 10 for the last 9 days (a later day without it
 *    yields a leave notification reading "was up for 1 week"; weeks show only on leaves)
 *  - Frieren (52991) entered 2 days ago, gone yesterday -> enter + leave notifications
 *  - events/meta reset; watch rows for the window reset
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const dayOffset = (day, delta) => {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
};
const today = new Date().toISOString().slice(0, 10);

await db.top10Event.deleteMany();
await db.top10Meta.deleteMany();
await db.watchStat.deleteMany({ where: { day: { gte: dayOffset(today, -20), lte: today } } });

// One Piece watched every day for the past 9 days (not today yet)
for (let i = 9; i >= 1; i--) {
  await db.watchStat.create({ data: { day: dayOffset(today, -i), malId: 21, seconds: 240, title: "One Piece", image: null } });
}
// Frieren watched only 2 days ago
await db.watchStat.create({ data: { day: dayOffset(today, -2), malId: 52991, seconds: 300, title: "Frieren", image: null } });

// cursor 10 days back -> the seal will publish D-9..D-1 on the next API touch
await db.top10Meta.create({ data: { key: "top10.lastSealed", value: dayOffset(today, -10) } });

const evs = await db.top10Event.count();
console.log(`seeded. events will be created by the seal on first request (currently ${evs})`);
process.exit(0);
