/**
 * turso-push.mjs — one-time catalog migration: local SQLite → Turso (libSQL).
 *
 * Copies EVERY table (schema + rows + indexes) from the packaged catalog DB
 * into a Turso database, so the app can run against an always-on cloud DB
 * (the $0 fix for ephemeral-disk hosts like Render free).
 *
 * FK-safe: tables are copied in topological order (parents before children)
 * and rows whose foreign keys point at missing parents are PRUNED with a
 * count — the source has accumulated a few orphans over time (deleted users
 * whose WatchProgress rows survived) and libSQL enforces constraints the
 * source silently ignored.
 *
 * Usage:
 *   TURSO_DATABASE_URL=libsql://your-db.turso.io \
 *   TURSO_AUTH_TOKEN=eyJ... \
 *   node scripts/turso-push.mjs [--fresh]
 *
 *   --fresh  DROP every existing table in the target first (destructive!).
 *            Without it the script REFUSES to touch a target that already
 *            has data, so an accidental re-run can't wipe anything.
 *
 * Works with a local file target too (handy for testing):
 *   TURSO_DATABASE_URL=file:/tmp/test.db node scripts/turso-push.mjs --fresh
 */

import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire('/home/z/my-project/src/package.json');
const Database = require('better-sqlite3');
const { createClient } = require('@libsql/client');

const here = dirname(fileURLToPath(import.meta.url));
const SRC_DB = join(here, '..', 'db', 'custom.db');

const url = process.env.TURSO_DATABASE_URL;
if (!url) {
  console.error('Set TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN for remote Turso DBs).');
  process.exit(1);
}
const fresh = process.argv.includes('--fresh');

const src = new Database(SRC_DB, { readonly: true });
const dst = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

const tables = src
  .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all();
const indexes = src
  .prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name")
  .all();

console.log(`source: ${SRC_DB} — ${tables.length} tables, ${indexes.length} indexes`);
console.log(`target: ${url.replace(/\/\/[^@]*@/, '//***@')}`);

/* ---- FK graph + topological order ----------------------------------- */

// table -> [{ toTable, fromCols[], toCols[] }]
const fkGraph = new Map();
for (const t of tables) {
  const raw = src.prepare(`PRAGMA foreign_key_list("${t.name}")`).all();
  const groups = new Map();
  for (const f of raw) {
    const id = f.id;
    if (!groups.has(id)) groups.set(id, { toTable: f.table, fromCols: [], toCols: [] });
    const g = groups.get(id);
    g.fromCols.push(f.from);
    g.toCols.push(f.to);
  }
  fkGraph.set(t.name, [...groups.values()].filter((g) => g.toTable !== t.name));
}

// Kahn's algorithm: parents (referenced) before children (referencing).
function topoOrder() {
  const names = tables.map((t) => t.name);
  const inDeg = new Map(names.map((n) => [n, 0]));
  const dependents = new Map(names.map((n) => [n, []])); // parent -> children
  for (const [child, fks] of fkGraph) {
    for (const fk of fks) {
      if (fkGraph.has(fk.toTable)) {
        inDeg.set(child, (inDeg.get(child) ?? 0) + 1);
        dependents.get(fk.toTable).push(child);
      }
    }
  }
  const queue = names.filter((n) => (inDeg.get(n) ?? 0) === 0).sort();
  const order = [];
  while (queue.length) {
    const n = queue.shift();
    order.push(n);
    for (const c of dependents.get(n)) {
      inDeg.set(c, inDeg.get(c) - 1);
      if (inDeg.get(c) === 0) queue.push(c);
    }
  }
  for (const n of names) if (!order.includes(n)) order.push(n); // cycle fallback
  return order;
}
const order = topoOrder();

async function main() {
  // ---- safety / fresh ----
  const probe = await dst.execute(
    "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  );
  const existing = Number(probe.rows[0].n);
  if (fresh && existing > 0) {
    console.log(`--fresh: dropping ${existing} existing table(s) in target...`);
    const drops = tables
      .map((t) => `DROP TABLE IF EXISTS "${t.name}"`)
      .concat(indexes.map((i) => `DROP INDEX IF EXISTS "${i.name}"`))
      .map((sql) => ({ sql, args: [] }));
    for (let i = 0; i < drops.length; i += 40) {
      await dst.batch(drops.slice(i, i + 40), 'write').catch(() => undefined);
    }
  } else if (existing > 0) {
    console.error(`\nTarget already has ${existing} table(s). Refusing to overwrite.`);
    console.error('Re-run with --fresh to DROP them first (destructive).');
    process.exit(1);
  }

  // ---- schema ----
  for (const t of tables) {
    await dst.execute(t.sql).catch((e) => {
      if (!String(e).includes('already exists')) throw e;
    });
  }
  for (const i of indexes) {
    await dst.execute(i.sql).catch((e) => {
      if (!String(e).toLowerCase().includes('already exists')) throw e;
    });
  }
  console.log('schema copied ✓\n');

  // ---- rows (topological order, orphan-pruned) ----
  const copiedRows = new Map(); // table -> kept rows (needed for FK parent lookups)
  const parentSetCache = new Map(); // "table|col,col" -> Set(key)
  let totalPruned = 0;

  const keyOf = (row, cols) => cols.map((c) => (row[c] == null ? '' : String(row[c]))).join('\u001f');

  /** Set of composite keys for one parent table under ONE specific column list. */
  function parentSet(table, cols) {
    const cacheKey = `${table}|${cols.join(',')}`;
    let set = parentSetCache.get(cacheKey);
    if (!set) {
      set = new Set();
      for (const row of copiedRows.get(table) ?? []) set.add(keyOf(row, cols));
      parentSetCache.set(cacheKey, set);
    }
    return set;
  }

  for (const name of order) {
    const t = tables.find((x) => x.name === name);
    const rows = src.prepare(`SELECT * FROM "${t.name}"`).all();
    const fks = fkGraph.get(t.name) ?? [];

    const keep = [];
    for (const row of rows) {
      let ok = true;
      for (const fk of fks) {
        if (!copiedRows.has(fk.toTable)) continue; // parent not part of the copy
        const k = keyOf(row, fk.fromCols);
        const hasNull = fk.fromCols.some((c) => row[c] == null);
        if (!hasNull && !parentSet(fk.toTable, fk.toCols).has(k)) {
          ok = false;
          break;
        }
      }
      if (ok) keep.push(row);
    }
    copiedRows.set(t.name, keep);
    const pruned = rows.length - keep.length;
    totalPruned += pruned;
    if (pruned > 0) console.log(`  ${t.name}: pruning ${pruned} orphaned row(s)`);

    if (keep.length === 0) {
      console.log(`  ${t.name}: 0 rows`);
      continue;
    }
    const cols = Object.keys(keep[0]);
    const colList = cols.map((c) => `"${c}"`).join(', ');
    const placeholders = cols.map(() => '?').join(', ');
    const insertSql = `INSERT INTO "${t.name}" (${colList}) VALUES (${placeholders})`;
    const toArg = (v) => (Buffer.isBuffer(v) ? new Uint8Array(v) : v);

    const BATCH = 100;
    for (let i = 0; i < keep.length; i += BATCH) {
      const stmts = keep.slice(i, i + BATCH).map((row) => ({
        sql: insertSql,
        args: cols.map((c) => toArg(row[c])),
      }));
      await dst.batch(stmts, 'write');
      process.stdout.write(`  ${t.name}: ${Math.min(i + BATCH, keep.length)}/${keep.length}\r`);
    }
    process.stdout.write(`  ${t.name}: ${keep.length} rows ✓${' '.repeat(20)}\n`);
  }

  // ---- AUTOINCREMENT counters ----
  try {
    const seq = src.prepare('SELECT * FROM sqlite_sequence').all();
    for (const row of seq) {
      await dst
        .execute({ sql: 'UPDATE sqlite_sequence SET seq = ? WHERE name = ?', args: [row.seq, row.name] })
        .catch(async () => {
          await dst.execute({ sql: 'INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)', args: [row.name, row.seq] });
        });
    }
    if (seq.length) console.log(`\nsqlite_sequence: ${seq.length} counters ✓`);
  } catch {
    /* no AUTOINCREMENT tables — fine */
  }

  if (totalPruned > 0) console.log(`pruned ${totalPruned} orphaned row(s) total (junk the source had been carrying)\n`);

  // ---- verify ----
  console.log('verification (source → target row counts, after pruning):');
  let mismatches = 0;
  for (const t of tables) {
    const s = src.prepare(`SELECT count(*) AS n FROM "${t.name}"`).get().n;
    const expected = (copiedRows.get(t.name) ?? []).length;
    const dres = await dst.execute(`SELECT count(*) AS n FROM "${t.name}"`);
    const d = Number(dres.rows[0].n);
    const prunedNote = s !== expected ? ` (pruned ${s - expected})` : '';
    const ok = d === expected ? '✓' : `✗ expected ${expected}`;
    if (d !== expected) mismatches++;
    console.log(`  ${t.name}: ${s} → ${d}${prunedNote} ${ok}`);
  }
  console.log(mismatches === 0 ? '\nCOPY COMPLETE — every target table is a pruned subset of source 🎉' : `\n${mismatches} table(s) wrong — investigate!`);
  process.exit(mismatches === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\npush failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
