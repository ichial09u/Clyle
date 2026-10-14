#!/usr/bin/env python3
"""
merge_export.py — fold live /api/export dumps into the bundled catalog DB.

Usage:
  python3 scripts/merge_export.py --db src/db/custom.db export1.json [export2.json ...]

Strategy per table (columns introspected from the SQLite file itself):
  - full-row tables  -> INSERT OR REPLACE (idempotent, id-keyed)
  - partial rows     -> INSERT OR IGNORE, only when every unique-index
                        column is present in the export (never clobbers)
  - WatchProgress    -> manual upsert on (userId, malId, episode), newer
                        updatedAt wins; generated row id (the cuid PK is
                        client-side and not part of the export)
  - RemovedProgress  -> tombstones, newer removedAt wins
DateTime columns arrive as ISO strings and are stored as epoch-ms ints
(Prisma's SQLite storage). Booleans arrive as true/false, stored as 1/0.
"""

import json
import os
import random
import sqlite3
import sys
import time
from datetime import datetime, timezone

TABLE_OF = {
    "users": "User",
    "comments": "Comment",
    "watchStats": "WatchStat",
    "top10Events": "Top10Event",
    "top10Meta": "Top10Meta",
    "deletedCommentIds": "DeletedComment",
    "anime": "Anime",
    "episodes": "Episode",
    "watchProgress": "WatchProgress",
    "removedProgress": "RemovedProgress",
    "introScout": "IntroScout",
    "scoutRef": "ScoutRef",
    "dubProbe": "DubProbe",
    "pushSubs": "PushSub",
}
NEWER_WINS = {
    "WatchProgress": "updatedAt",
    "RemovedProgress": "removedAt",
}
KEY_OF = {
    "WatchProgress": ["userId", "malId", "episode"],
    "RemovedProgress": ["userId", "malId"],
}


def to_ms(v):
    if isinstance(v, (int, float)):
        return int(v)
    s = str(v)
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def coerce(col_type, v):
    t = (col_type or "").upper()
    if "DATETIME" in t and isinstance(v, str):
        ms = to_ms(v)
        return ms if ms is not None else v
    if "BOOLEAN" in t and isinstance(v, bool):
        return 1 if v else 0
    return v


def uniq_cols(con, table):
    """Columns covered by the table's unique indexes (PK included)."""
    cols = set()
    for idx in con.execute(f'PRAGMA index_list("{table}")'):
        if idx[2]:  # unique
            names = [r[2] for r in con.execute(f'PRAGMA index_info("{idx[1]}")')]
            cols.update(names)
    for info in con.execute(f'PRAGMA table_info("{table}")'):
        if info[5] > 0:  # pk member
            cols.add(info[1])
    return cols


def merge_table(con, table, rows, stats):
    if not rows:
        return
    info = list(con.execute(f'PRAGMA table_info("{table}")'))
    table_cols = [c[1] for c in info]
    col_type = {c[1]: c[2] for c in info}
    uniq = uniq_cols(con, table)
    key = KEY_OF.get(table)
    newer_field = NEWER_WINS.get(table)
    ins = upd = skip = 0
    cur = con.cursor()

    for raw in rows:
        if table == "DeletedComment" and not isinstance(raw, dict):
            raw = {"id": raw}
        vals = {}
        for k, v in raw.items():
            if k in col_type:
                vals[k] = coerce(col_type[k], v)
        if not vals:
            skip += 1
            continue

        # ---- manual newer-wins upsert ----
        if key:
            kv = [vals.get(c) for c in key]
            if any(v is None for v in kv):
                skip += 1
                continue
            existing = cur.execute(
                f'SELECT {newer_field} FROM "{table}" WHERE ' + " AND ".join(f'"{c}" = ?' for c in key),
                kv,
            ).fetchone()
            incoming = vals.get(newer_field)
            if existing is not None:
                have = existing[0]
                if isinstance(have, str):
                    have = to_ms(have)
                if have is not None and incoming is not None and have > incoming + 1000:
                    skip += 1
                    continue
                sets = ", ".join(f'"{c}" = ?' for c in vals if c not in key)
                if sets:
                    cur.execute(
                        f'UPDATE "{table}" SET {sets} WHERE ' + " AND ".join(f'"{c}" = ?' for c in key),
                        [vals[c] for c in vals if c not in key] + kv,
                    )
                    upd += 1
                else:
                    skip += 1
                continue
            if table == "WatchProgress" and "id" not in vals:
                vals["id"] = f"sv-{int(time.time() * 1000):x}-{random.randrange(1 << 32):08x}"
            cols = list(vals)
            cur.execute(
                f'INSERT INTO "{table}" (' + ", ".join(f'"{c}"' for c in cols) + ") VALUES ("
                + ", ".join("?" for _ in cols) + ")",
                [vals[c] for c in cols],
            )
            ins += 1
            continue

        # ---- generic path: REPLACE only when the row is complete ----
        partial = set(table_cols) - set(vals)
        if partial and not partial <= uniq:
            # partial row whose gap breaks uniqueness -> IGNORE (add-only)
            if not uniq <= set(vals):
                skip += 1
                continue
            cols = list(vals)
            cur.execute(
                f'INSERT OR IGNORE INTO "{table}" (' + ", ".join(f'"{c}"' for c in cols) + ") VALUES ("
                + ", ".join("?" for _ in cols) + ")",
                [vals[c] for c in cols],
            )
            if cur.rowcount:
                ins += 1
            else:
                skip += 1
        else:
            cols = list(vals)
            cur.execute(
                f'INSERT OR REPLACE INTO "{table}" (' + ", ".join(f'"{c}"' for c in cols) + ") VALUES ("
                + ", ".join("?" for _ in cols) + ")",
                [vals[c] for c in cols],
            )
            ins += 1

    stats[table] = (ins, upd, skip)


def main():
    args = sys.argv[1:]
    db = None
    files = []
    i = 0
    while i < len(args):
        if args[i] == "--db":
            db = args[i + 1]
            i += 2
        else:
            files.append(args[i])
            i += 1
    if not db or not files:
        sys.exit("usage: merge_export.py --db <sqlite file> <export.json> [...]")

    con = sqlite3.connect(db)
    con.execute("PRAGMA foreign_keys = OFF")
    stats = {}
    loaded = 0
    for f in files:
        if not os.path.exists(f) or os.path.getsize(f) == 0:
            print(f"skip {f} (missing/empty)")
            continue
        try:
            data = json.load(open(f))
        except json.JSONDecodeError:
            print(f"skip {f} (not valid JSON)")
            continue
        loaded += 1
        with con:
            for jkey, table in TABLE_OF.items():
                if jkey in data and isinstance(data[jkey], list):
                    merge_table(con, table, data[jkey], stats)

    ok = con.execute("PRAGMA integrity_check").fetchone()[0]
    print(f"merged {loaded} export(s); integrity: {ok}")
    print(f"{'table':<16} {'inserted':>8} {'updated':>8} {'skipped':>8}")
    for table, (ins, upd, skip) in sorted(stats.items()):
        print(f"{table:<16} {ins:>8} {upd:>8} {skip:>8}")
    con.close()
    if ok != "ok":
        sys.exit("integrity check FAILED")


if __name__ == "__main__":
    main()
