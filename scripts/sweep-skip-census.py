#!/usr/bin/env python3
"""
Battalion 2 — FRESH skip-intro census (Oct 11 2026 re-run).

Recomputes, for every in-catalog episode (sub + dub share the same timelines),
which skip tier covers its OP/ED, mirroring src/lib/skip-times.ts exactly:

  tier 0  exact      — vendored skip-times.data.json has this malId+ep op/ed
  tier 1  consensus  — dataset has ANY op/ed rows for the show (median fills gaps)
  tier 2  skipdb     — SkipDbFill row for this malId+ep
  tier 3  scout      — IntroScout row for this malId+ep (quality exact/median)
  tier 4  live-cache — aniskip-cache/<sha>.json on disk (hash = `${malId}:${ep}:${len}`)

Also applies the plausibility gates the app applies (OP start<=320s, len<=180s;
ED start<=300s) so a garbage row isn't counted as coverage.

Output: scripts/sweep-skip-census.json + console summary.
"""
import json
import hashlib
import sqlite3
import time
from collections import defaultdict
from pathlib import Path

ROOT = Path("/home/z/my-project/src")
DB_PATH = ROOT / "db" / "custom.db"
DATASET = ROOT / "src" / "lib" / "skip-times.data.json"
CACHE_DIR = ROOT / "db" / "aniskip-cache"
OUT = Path("/home/z/my-project/scripts/sweep-skip-census.json")

OP_START_MAX = 320.0
OP_LEN_MAX = 180.0
ED_START_MAX = 300.0


def op_ok(iv, long_fmt=False):
    if not iv:
        return False
    s, e = iv
    cap = 420.0 if long_fmt else OP_START_MAX
    return s <= cap and 0 < (e - s) <= OP_LEN_MAX


def ed_ok(iv):
    # mirrors plausibleOutro(): outro only needs a sane shape, no start cap —
    # EDs legitimately start at ~22:00 into a 24-minute episode
    if not iv:
        return False
    s, e = iv
    return 0 < (e - s) <= 300.0


def median(vals):
    v = sorted(vals)
    n = len(v)
    if n == 0:
        return None
    return v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2


def main():
    t0 = time.time()
    data = json.loads(DATASET.read_text())

    # per-show consensus (median op/ed across exact rows)
    consensus = {}
    for mal, eps in data.items():
        for kind, gate in (("op", op_ok), ("ed", ed_ok)):
            starts = [e[kind][0] for e in eps.values() if e.get(kind) and gate(e[kind])]
            ends = [e[kind][1] for e in eps.values() if e.get(kind) and gate(e[kind])]
            if starts and ends:
                consensus.setdefault(mal, {})[kind] = (
                    round(median(starts), 1), round(median(ends), 1)
                )

    db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    cur = db.cursor()

    # catalog shows + episode ranges
    shows = {
        str(r[0]): r[1]
        for r in cur.execute(
            "SELECT malId, title FROM Anime WHERE inCatalog=1 AND (malId IS NULL OR malId < 999900)"
        )
    }

    # existing episode numbers per show (sub rows — dub rides the same timeline)
    eps_by_show = defaultdict(list)
    for mal, num in cur.execute("SELECT animeId, number FROM Episode WHERE lang='sub'"):
        eps_by_show[str(mal)].append(int(num))

    # SkipDbFill: per malId+ep op/ed rows (plausibility-gated)
    skipdb = defaultdict(dict)  # mal -> ep -> set(kinds)
    for mal, ep, kind, start, end in cur.execute(
        "SELECT malId, ep, kind, start, end FROM SkipDbFill"
    ):
        iv = (start, end)
        if kind == "op" and op_ok(iv):
            skipdb[str(mal)].setdefault(int(ep), set()).add("op")
        elif kind == "ed" and ed_ok(iv):
            skipdb[str(mal)].setdefault(int(ep), set()).add("ed")

    # IntroScout — mirrors scoutIntro(): exact row (nodetect=confirmedNone,
    # valid end>start = interval) OR anime-wide median across >=2 measured rows
    # gated by (end-start)<=150 && start<=320. Census counts OP coverage only
    # (scout rows are intro measurements).
    scout = defaultdict(dict)
    scout_rows = defaultdict(list)
    for mal, ep, start, end, nodetect in cur.execute(
        "SELECT malId, ep, start, end, nodetect FROM IntroScout"
    ):
        scout_rows[str(mal)].append((int(ep), start, end, bool(nodetect)))
    for mal, rows in scout_rows.items():
        measured = [(ep, s, e) for (ep, s, e, nd) in rows if not nd and e and s and e > s]
        med_start = med_end = None
        if len(measured) >= 2:
            med_start = sorted(m[1] for m in measured)[len(measured) // 2]
            med_end = sorted(m[2] for m in measured)[len(measured) // 2]
            if not (med_end > med_start and med_end - med_start <= 150 and med_start <= 320):
                med_start = med_end = None
        for (ep, s, e, nd) in rows:
            if nd:
                continue  # confirmedNone = deliberately no button, counts as COVERED-no-op
            if e and s and e > s and s <= 320 and 0 < (e - s) <= 180:
                scout[mal].setdefault(ep, set()).add("op")
            elif med_start is not None:
                scout[mal].setdefault(ep, set()).add("op")

    # duration minutes per show (hour-long plausibility cap)
    lens = {
        str(r[0]): (r[1] or 24)
        for r in cur.execute("SELECT malId, durationMin FROM Anime WHERE inCatalog=1")
    }

    # live-cache: db/aniskip-cache/sha1(malId)[:16].json = { "ep": {op?, ed?, at, miss?} }
    cached = {}
    if CACHE_DIR.exists():
        cached = {p2.stem: json.loads(p2.read_text()) for p2 in CACHE_DIR.glob("*.json")}
    mal_to_cache = {}
    for mal in shows:
        h = hashlib.sha1(mal.encode()).hexdigest()[:16]
        if h in cached:
            mal_to_cache[mal] = cached[h]

    def live_hit(mal, ep):
        f = mal_to_cache.get(mal)
        if not f:
            return False
        entry = f.get(str(ep))
        if not entry or entry.get("miss"):
            return False
        return op_ok(entry.get("op")) or ed_ok(entry.get("ed"))

    # ---- census ----
    total = 0
    tier_op = defaultdict(int)
    tier_ed = defaultdict(int)
    no_op = []  # (mal, title, count) episodes with NO op coverage from any tier
    per_show_gap = defaultdict(int)
    mal_title = shows

    for mal, eps in eps_by_show.items():
        if mal not in shows:
            continue  # not in catalog (or SP synthetic ids — different pipeline)
        ds = data.get(mal, {})
        cons = consensus.get(mal, {})
        sdb = skipdb.get(mal, {})
        sct = scout.get(mal, {})
        for ep in eps:
            total += 1
            key = str(ep)
            exact = ds.get(key, {})
            long_fmt = (lens.get(mal) or 24) > 30
            op = None
            tier = None
            if op_ok(exact.get("op"), long_fmt):
                op, tier = exact["op"], "exact"
            elif op_ok(cons.get("op"), long_fmt):
                op, tier = cons["op"], "consensus"
            elif "op" in sdb.get(ep, ()):
                op, tier = sdb[ep] and (0, 0), "skipdb"
            elif "op" in sct.get(ep, ()):
                op, tier = (0, 0), "scout"
            elif live_hit(mal, ep):
                op, tier = (0, 0), "live"
            if op is None:
                no_op.append((mal, mal_title.get(mal, "?"), ep))
                per_show_gap[mal] += 1
            else:
                tier_op[tier] += 1

            ed = None
            etier = None
            if ed_ok(exact.get("ed")):
                ed, etier = exact["ed"], "exact"
            elif ed_ok(cons.get("ed")):
                ed, etier = cons["ed"], "consensus"
            elif "ed" in sdb.get(ep, ()):
                ed, etier = (0, 0), "skipdb"
            elif "ed" in sct.get(ep, ()):
                ed, etier = (0, 0), "scout"
            if ed:
                tier_ed[etier] += 1

    op_covered = total - len(no_op)
    report = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "catalogShowsCensus": len(eps_by_show),
        "totalEpisodes": total,
        "opCovered": op_covered,
        "opCoveragePct": round(100 * op_covered / max(total, 1), 2),
        "opTiers": dict(tier_op),
        "edCovered": sum(tier_ed.values()),
        "edCoveragePct": round(100 * sum(tier_ed.values()) / max(total, 1), 2),
        "edTiers": dict(tier_ed),
        "showsMissingAllOp": len([m for m in eps_by_show if m in shows and per_show_gap[m] == len(eps_by_show[m])]),
        "topGapShows": sorted(
            (
                {
                    "malId": int(m),
                    "title": mal_title.get(m, "?"),
                    "gapEps": per_show_gap[m],
                    "totalEps": len(eps_by_show[m]),
                }
                for m in per_show_gap
                if m in shows and per_show_gap[m] >= 3
            ),
            key=lambda x: -x["gapEps"],
        )[:40],
        "sampleNoOpEpisodes": no_op[:25],
        "elapsedSec": round(time.time() - t0, 1),
    }
    OUT.write_text(json.dumps(report, indent=1))
    print(json.dumps({k: v for k, v in report.items() if k not in ("topGapShows", "sampleNoOpEpisodes")}, indent=1))
    print("\nTOP GAP SHOWS (>=3 eps with no OP data):")
    for s in report["topGapShows"][:15]:
        print(f"  {s['malId']:>7} {s['title'][:44]:46} gap {s['gapEps']}/{s['totalEps']}")


if __name__ == "__main__":
    main()
