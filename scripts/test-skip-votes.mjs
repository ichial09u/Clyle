/**
 * Crowd-learned Skip Intro test (DEV ONLY — writes votes to the local db).
 *
 * 49233 (Youjo Senki II, 2026) has no skip data in Zoko, the vendored dump,
 * or AniSkip — perfect for verifying the crowd tier:
 *   1. three ep-1 votes 160/170/180 -> ep1 median 170, source "crowd"
 *   2. a 4th vote (155, ep 1) -> anime-wide median covers ep 2 too
 *   3. cleanup wipes the votes
 * Run against the dev server.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const BASE = "http://localhost:3000";
const MAL = 49233;

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
};

const post = async (ep, target) =>
  fetch(`${BASE}/api/skip-vote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ malId: MAL, ep, target }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const stream = async (ep) =>
  fetch(`${BASE}/api/stream?malId=${MAL}&ep=${ep}&lang=sub&server=zoko`)
    .then((r) => r.json())
    .catch(() => null);

await db.skipVote.deleteMany({ where: { malId: MAL } });

// invalid votes rejected
check("vote rejected for out-of-range target", (await post(1, 15)).body?.ok === false);
check("vote rejected for unknown anime", (await post(99999999, 120)).body?.ok === false);

await post(1, 160);
await post(1, 170);
await post(1, 180);
let s = await stream(1);
check("3 ep votes -> intro 8->170 (median), source crowd", s?.skip?.intro?.end === 170 && s?.skip?.source === "crowd", JSON.stringify(s?.skip));

await post(1, 155);
s = await stream(1);
check("4th vote -> ep1 median still 170", s?.skip?.intro?.end === 170, JSON.stringify(s?.skip));
const s2 = await stream(2);
check("anime-wide median (4 votes) covers ep 2", s2?.skip?.intro?.end === 170 && s2?.skip?.source === "crowd", JSON.stringify(s2?.skip));

const after = await db.skipVote.count({ where: { malId: MAL } });
check("4 votes stored", after === 4, `count=${after}`);

await db.skipVote.deleteMany({ where: { malId: MAL } });
console.log(failures === 0 ? "\nALL GREEN" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
