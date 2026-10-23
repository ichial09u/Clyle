/**
 * turso-smoke.mjs — validates a Turso/libSQL database through the exact same
 * Prisma + @prisma/adapter-libsql path the app uses (src/lib/db.ts).
 *
 *   TURSO_DATABASE_URL=libsql://your-db.turso.io \
 *   TURSO_AUTH_TOKEN=eyJ... \
 *   node scripts/turso-smoke.mjs
 *
 * Checks: catalog count query (the app's most common read), a real WRITE
 * (create + update + delete of a throwaway User row), and reports timings.
 * Exit 0 = the DB is ready to serve the app.
 */

import { createRequire } from 'node:module';

const require = createRequire('/home/z/my-project/src/package.json');
const { PrismaClient } = require('@prisma/client');
const { PrismaLibSQL } = require('@prisma/adapter-libsql');

const url = process.env.TURSO_DATABASE_URL;
if (!url) {
  console.error('Set TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN for remote Turso DBs).');
  process.exit(1);
}
console.log(`target: ${url.replace(/\/\/[^@]*@/, '//***@')}`);

const db = new PrismaClient({
  adapter: new PrismaLibSQL({ url, authToken: process.env.TURSO_AUTH_TOKEN }),
  log: ['error'],
});

const ms = (t0) => `${Date.now() - t0}ms`;

try {
  // 1) the app's signature read: catalog count
  let t0 = Date.now();
  const titles = await db.anime.count({ where: { inCatalog: true } });
  console.log(`read  ✓ catalog titles: ${titles} (${ms(t0)})`);

  t0 = Date.now();
  const eps = await db.episode.count();
  console.log(`read  ✓ episodes: ${eps} (${ms(t0)})`);

  // 2) a real write round-trip: throwaway User row (User.id is app-assigned,
  //    no @default — mirror what the app does)
  t0 = Date.now();
  const smokeId = `smoke_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const u = await db.user.create({ data: { id: smokeId, nickname: 'turso-smoke' } });
  await db.user.update({ where: { id: u.id }, data: { nickname: 'turso-smoke-ok' } });
  const back = await db.user.findUnique({ where: { id: u.id } });
  if (back?.nickname !== 'turso-smoke-ok') throw new Error('write round-trip failed');
  await db.user.delete({ where: { id: u.id } });
  console.log(`write ✓ create/update/read/delete round-trip (${ms(t0)})`);

  // 3) confirm cleanup
  const leftovers = await db.user.count({ where: { id: smokeId } });
  if (leftovers !== 0) throw new Error('cleanup failed');
  console.log('\nDB IS READY — the app can serve from this database 🎉');
  process.exit(0);
} catch (e) {
  console.error('\nSMOKE TEST FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
} finally {
  await db.$disconnect();
}
