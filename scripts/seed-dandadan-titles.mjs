/**
 * Seed Dandadan S1 (57334) episode titles — MAL episode-page scrape.
 * Jikan's /episodes endpoint is 504-shedding for this show; the MAL page
 * itself answers fine and carries the English titles as the primary link
 * text:  <a href=".../episode/N" class="fl-l fw-b ">That's How Love Starts…</a>
 *   node scripts/seed-dandadan-titles.mjs
 */
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const MALID = 57334;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const html = execFileSync("curl", [
  "-sS", "--max-time", "30", "-A", UA,
  `https://myanimelist.net/anime/${MALID}/DAN_DA_DAN/episode`,
], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

const re = /<a href="https:\/\/myanimelist\.net\/anime\/\d+\/[^"]*\/episode\/(\d+)" class="fl-l fw-b\s*">([^<]+)<\/a>/g;
const seen = new Map();
let m;
while ((m = re.exec(html))) {
  const n = parseInt(m[1], 10);
  const title = m[2].replace(/&#0?39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&ldquo;|&rdquo;/g, '"').trim();
  if (n > 0 && title && !/^Episode\s*\d+$/i.test(title)) seen.set(n, title);
}
console.log(`scraped ${seen.size} titles from MAL`);

let filled = 0;
for (const [n, title] of [...seen.entries()].sort((a, b) => a[0] - b[0])) {
  const r = await db.episode.updateMany({
    where: { animeId: MALID, number: n, lang: "sub", title: null },
    data: { title },
  });
  filled += r.count;
  if (r.count) console.log(`ep${n}: ${title}`);
}
console.log(`filled ${filled} titles`);
await db.$disconnect();
