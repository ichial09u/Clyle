/**
 * Removes synthetic Top 10 test rows from the LOCAL dev db so a deploy never
 * ships them to production: the deploy merge (deploy-vercel.mjs /
 * build-deploy-zip.sh) is additive — it re-imports the live export but never
 * deletes local rows. Run BEFORE deploying after test-top10-notifs.mjs /
 * e2e-smoke.mjs. Live Top10Event/Top10Meta and any real WatchStat rows come
 * back from the live export during the merge; local lastSealed resets to the
 * live cursor so re-sealing re-diffs (deduped) instead of faking events.
 *
 * The three scratch malIds are the test's catalog picks (lowest malIds —
 * see test-top10-notifs.mjs); their live rows are re-imported by the merge.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const picks = await db.anime.findMany({ select: { malId: true }, take: 3, orderBy: { malId: "asc" } });
const ids = picks.map((p) => p.malId);

const events = await db.top10Event.deleteMany({});
const meta = await db.top10Meta.deleteMany({});
const stats = await db.watchStat.deleteMany({ where: { malId: { in: ids } } });
console.log(`cleaned: ${events.count} top10Event rows, ${meta.count} top10Meta rows, ${stats.count} watchStat rows for scratch ids [${ids.join(", ")}]`);
