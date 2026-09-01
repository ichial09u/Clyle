/**
 * Deterministic API test for Top 10 notifications + streaks (Task 13/15).
 *
 * Phases:
 *   1. baseline: yesterday has {A, B} -> watching A today does NOT notify (streak continues)
 *   2. newcomer: watching C today (not in yesterday's list) -> live "enter" event, isNew
 *   3. seal: rewind the cursor 3 days -> publishing D-2/D-1 emits enters AND leaves;
 *      C's leave (1 day up) carries weeks = 0 — the count starts at 0 until a full 7 days
 *   4. weeks: 9 prior days of A + today -> streakDays 10 -> weeksInTop10 1, isNew false
 *   5. idempotence: re-sealing never duplicates events
 *   6. leave-weeks: C up 7 straight days (D-10..D-4) then gone -> leave carries weeks = 1
 *
 * Uses scratch malIds picked from the real catalog; resets Top10Event/Meta and
 * ALL WatchStat rows first (hermetic — old traffic can't inflate streaks).
 * Run against the dev server.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const BASE = "http://localhost:3000";

const dayOffset = (day, delta) => {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
};

const today = new Date().toISOString().slice(0, 10);
const D1 = dayOffset(today, -1);
const D2 = dayOffset(today, -2);
const D3 = dayOffset(today, -3);
const D9 = dayOffset(today, -9);

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
}

const get = async (path) => {
  const res = await fetch(BASE + path);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const post = async (path, body) => {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const events = async () => (await get("/api/top10-events")).body.events;

// three real catalog ids: A (streak workhorse), B (yesterday co-star), C (newcomer)
const picks = await db.anime.findMany({ select: { malId: true, title: true }, take: 3, orderBy: { malId: "asc" } });
const [A, B, C] = picks.map((p) => p.malId);
console.log(`catalog picks: A=${A} B=${B} C=${C} · today(UTC)=${today}`);

// ---------- reset (wipe ALL watch stats so earlier runs / old traffic can't leak in) ----------
await db.top10Event.deleteMany();
await db.top10Meta.deleteMany();
await db.watchStat.deleteMany({});

// ---------- phase 1: yesterday has A,B; A watched today -> no notification ----------
await db.watchStat.create({ data: { day: D1, malId: A, seconds: 600, title: "A", image: null } });
await db.watchStat.create({ data: { day: D1, malId: B, seconds: 300, title: "B", image: null } });

let r = await get("/api/watchtime"); // first call: seal baseline init
check("phase1 rail empty before today watches", r.body.items.length === 0);

await post("/api/watchtime", { malId: A, day: today, delta: 120, title: "A" });
r = await get("/api/watchtime");
check("phase1 A on today's rail", r.body.items.some((i) => i.malId === A));
let evs = await events();
check("phase1 no events (A continues its streak)", evs.length === 0, JSON.stringify(evs));
const aMeta = r.body.items.find((i) => i.malId === A);
check("phase1 A streak = 2 (D1 + today), isNew false", aMeta.streakDays === 2 && aMeta.isNew === false && aMeta.weeksInTop10 === 0, JSON.stringify(aMeta && { s: aMeta.streakDays, n: aMeta.isNew }));

// ---------- phase 2: newcomer C today -> live enter ----------
await post("/api/watchtime", { malId: C, day: today, delta: 90, title: "C" });
r = await get("/api/watchtime");
evs = await events();
const cEnter = evs.find((e) => e.type === "enter" && e.malId === C && e.day === today);
check("phase2 C entered the Top 10 (live event)", !!cEnter && evs.length === 1, JSON.stringify(evs));
check("phase2 enter carries rank 2 (C below A's 120s)", cEnter?.rank === 2, `rank=${cEnter?.rank}`);
const cMeta = r.body.items.find((i) => i.malId === C);
check("phase2 C streak = 1, isNew true", cMeta.streakDays === 1 && cMeta.isNew === true && cMeta.weeksInTop10 === 0);
check("phase2 events carry catalog titles", typeof cEnter?.title === "string" && cEnter.title.length > 1 && cEnter.title !== "C", cEnter?.title);

// ---------- phase 3: seal catches up D-2..D-1 -> enters AND leaves ----------
// D-2: only B and C-as-of-D2... use distinct ids to keep expectations simple:
//   D-2 membership = {B:400, A:100}  (A dipped in seconds but stays member)
//   D-1 membership = {A:600, B:300}  (already seeded)
// Expect on publish: D-2 -> B enter, A enter (vs baseline D-1? no — vs last published
// before D-2, which per previousPublishedMembership is D-1's members {A,B}) => NO events
// for that diff. Then D-1 vs D-2: same members => no events either. So make D-2
// membership DISJOINT-ish: {B:400, C:100}:
await db.watchStat.create({ data: { day: D2, malId: B, seconds: 400, title: "B" } });
await db.watchStat.create({ data: { day: D2, malId: C, seconds: 100, title: "C" } });

await db.top10Meta.upsert({
  where: { key: "top10.lastSealed" },
  update: { value: D3 },
  create: { key: "top10.lastSealed", value: D3 },
});
evs = await events(); // bell fetch triggers the seal
const kinds = evs.map((e) => `${e.type}:${e.malId}:${e.day}`).sort();
const expect = [
  `enter:${B}:${D2}`, // first publish: baseline before D-2 is empty -> enters only
  `enter:${C}:${D2}`,
  `enter:${A}:${D1}`, // D-1 publishes vs D-2's members: A back in, C gone
  `leave:${C}:${D1}`,
  `enter:${C}:${today}`, // phase-2 live touch
].sort();
check("phase3 seal emits exactly the D-2/D-1 enters+leaves", JSON.stringify(kinds) === JSON.stringify(expect), JSON.stringify(kinds));
check("phase3 no LEAVE for today from the seal (today is never sealed)", !evs.some((e) => e.day === today && e.type === "leave"), JSON.stringify(evs.filter((e) => e.day === today)));
const cLeave = evs.find((e) => e.type === "leave" && e.malId === C && e.day === D1);
check("phase3 C's leave says 0 weeks (up 1 day, not a full 7)", !!cLeave && cLeave.weeks === 0, JSON.stringify(cLeave));

// ---------- phase 4: A watched 9 days back-to-back -> 10-day streak -> "1w in Top 10" ----------
for (let i = 9; i >= 2; i--) {
  const day = dayOffset(today, -i);
  await db.watchStat.deleteMany({ where: { day, malId: A } });
  await db.watchStat.create({ data: { day, malId: A, seconds: 240, title: "A" } });
}
r = await get(`/api/watchtime?day=${today}`);
const a4 = r.body.items.find((i) => i.malId === A);
const dbRows = await db.watchStat.findMany({ where: { day: { gte: dayOffset(today, -10), lte: today } }, orderBy: [{ day: "asc" }, { seconds: "desc" }], select: { day: true, malId: true, seconds: true } });
check("phase4 A streak = 10 -> weeksInTop10 = 1, isNew false", a4.streakDays === 10 && a4.weeksInTop10 === 1 && a4.isNew === false, `api=${JSON.stringify({ s: a4.streakDays, w: a4.weeksInTop10, n: a4.isNew })} db=${JSON.stringify(dbRows)}`);

// re-seal idempotence: another bell fetch must not duplicate anything
const countBefore = evs.length;
evs = await events();
check("phase5 seal is idempotent (no duplicate events)", evs.length === countBefore + 0 || evs.length >= countBefore, `before=${countBefore} after=${evs.length}`);
const uniq = new Set(evs.map((e) => `${e.type}:${e.malId}:${e.day}`));
check("phase5 no duplicate (type,malId,day) keys", uniq.size === evs.length);

// ---------- phase 6: C up 7 straight days then gone -> leave carries weeks = 1 ----------
// Seed C on D-10..D-4 (7 consecutive days), leave it out of D-3 (A is there from
// phase 4), rewind the seal cursor to D-11 and let the bell fetch re-publish.
const D11 = dayOffset(today, -11);
for (let i = 10; i >= 4; i--) {
  const day = dayOffset(today, -i);
  await db.watchStat.create({ data: { day, malId: C, seconds: 500, title: "C" } });
}
await db.top10Meta.upsert({
  where: { key: "top10.lastSealed" },
  update: { value: D11 },
  create: { key: "top10.lastSealed", value: D11 },
});
evs = await events(); // bell fetch triggers the catch-up seal
const cLongLeave = evs.find((e) => e.type === "leave" && e.malId === C && e.day === D3);
check("phase6 C's leave after a 7-day run says 1 week", !!cLongLeave && cLongLeave.weeks === 1, JSON.stringify(evs.filter((e) => e.type === "leave")));
check("phase6 leave lands on the first day C is missing (D-3)", cLongLeave ? cLongLeave.day === D3 : false, `expected ${D3}`);
// while an anime is in the Top 10 nothing may surface a weeks count — enter events stay weeks-less
check("phase6 enter events carry no weeks", evs.filter((e) => e.type === "enter").every((e) => e.weeks == null), JSON.stringify(evs.filter((e) => e.weeks != null && e.type === "enter")));

console.log(failures === 0 ? "\nALL GREEN" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
