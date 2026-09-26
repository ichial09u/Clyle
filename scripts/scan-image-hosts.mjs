// Scan local catalog for image host distribution + non-CDN rows (potential browser-blocked URLs)
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

const rows = await db.anime.findMany({ select: { malId: true, title: true, image: true, banner: true, logoUrl: true } });
const hosts = {};
const weird = [];
for (const r of rows) {
  for (const [field, url] of [["image", r.image], ["banner", r.banner], ["logo", r.logoUrl]]) {
    if (!url) continue;
    let h = "BROKEN";
    try { h = new URL(url).host; } catch {}
    const k = `${field}:${h}`;
    hosts[k] = (hosts[k] || 0) + 1;
    if (!/anilist\.co$|myanimelist\.net$/.test(h)) weird.push([r.malId, (r.title || "").slice(0, 30), field, url.slice(0, 90)]);
  }
}
console.log("total anime rows:", rows.length);
console.log("host distribution:", JSON.stringify(hosts, null, 1));
console.log("\nnon-anilist/mal rows:");
for (const w of weird.slice(0, 40)) console.log(" ", w.join(" | "));
console.log("weird total:", weird.length);

const op = await db.anime.findUnique({ where: { malId: 21 }, select: { image: true, banner: true, logoUrl: true, title: true } });
console.log("\nOne Piece row:", JSON.stringify(op, null, 1));
await db.$disconnect();
