// One Piece (malId 21) intro coverage census — sub vs dub state of the DB
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

const MAL = 21;

const [anime, total, scouts, nodetect, eps] = await Promise.all([
  db.anime.findUnique({ where: { malId: MAL }, select: { title: true, totalEpisodes: true, hasDub: true } }),
  db.episode.count({ where: { animeId: MAL } }),
  db.introScout.count({ where: { malId: MAL } }),
  db.introScout.count({ where: { malId: MAL, nodetect: true } }),
  db.episode.findMany({ where: { animeId: MAL }, select: { number: true, lang: true }, orderBy: { number: "desc" }, take: 3 }),
]);

console.log("anime:", anime?.title, "| totalEpisodes:", anime?.totalEpisodes, "| episode rows:", total, "| max ep row:", eps[0]?.number);
console.log("IntroScout rows:", scouts, "| nodetect:", nodetect, "| with interval:", scouts - nodetect);

// distribution of starts/ends for One Piece
const rows = await db.introScout.findMany({ where: { malId: MAL, nodetect: false }, select: { ep: true, start: true, end: true, bots: true, quality: true }, orderBy: { ep: "asc" } });
if (rows.length) {
  const starts = rows.map(r => r.start), ends = rows.map(r => r.end);
  console.log("interval eps range:", rows[0].ep, "-", rows[rows.length - 1].ep);
  console.log("start  min/med/max:", Math.min(...starts).toFixed(1), starts.sort((a,b)=>a-b)[Math.floor(starts.length/2)].toFixed(1), Math.max(...starts).toFixed(1));
  console.log("end    min/med/max:", Math.min(...ends).toFixed(1), ends.sort((a,b)=>a-b)[Math.floor(ends.length/2)].toFixed(1), Math.max(...ends).toFixed(1));
}

// check the aniskip vendored dataset for malId 21
const fs = await import("fs");
const p = "src/data/aniskip.json";
if (fs.existsSync(p)) {
  const data = JSON.parse(fs.readFileSync(p, "utf8"));
  const op = (Array.isArray(data) ? data : []).filter(d => (d.animeID ?? d.animeId ?? d.malId) === MAL);
  console.log("aniskip.json rows for 21:", op.length, op.slice(0, 2));
} else {
  // find the dataset
  const found = [];
  for (const f of fs.readdirSync("src/data")) found.push(f);
  console.log("src/data:", found.join(", "));
  const csv = fs.readFileSync("scripts/aniskip_dump.csv", "utf8").split("\n");
  const opLines = csv.filter(l => l.startsWith("21,") || l.includes(",21,")).slice(0, 3);
  console.log("aniskip_dump.csv total lines:", csv.length, "| malId-21 lines:", csv.filter(l => l.split(",")[1] === "21" || l.split(",")[0] === "21").length);
  console.log("sample:", opLines.slice(0, 2));
}

await db.$disconnect();
