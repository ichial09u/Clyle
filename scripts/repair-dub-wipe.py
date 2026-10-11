#!/usr/bin/env python3
"""
Dub-wipe repair sweep — for every catalog show whose fleet verdicts prove a
real dub existed but whose hasDub/hasDubKiwi flags are 0, probe ZOKO upstream
directly (bypassing the app's flag short-circuit). Flip the flags ONLY when
Zoko still serves a dub payload today; the app's per-episode segment compare
still guards fake dubs at play time.
"""
import sqlite3
import subprocess
import json
import time
import sys
import importlib.util

_spec = importlib.util.spec_from_file_location(
    "zoko_payload_probe", "/home/z/my-project/scripts/zoko-payload-probe.py"
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
fetch = _mod.fetch

DB = "/home/z/my-project/src/db/custom.db"


def suspects():
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    cur = db.cursor()
    rows = cur.execute(
        """
        SELECT DISTINCT a.malId, a.title
        FROM Anime a
        WHERE a.hasDub=0 AND a.hasDubKiwi=0 AND a.inCatalog=1 AND a.malId < 999900
        AND (
          EXISTS (SELECT 1 FROM DubAudio da WHERE da.malId=a.malId AND da.verdict='real')
          OR EXISTS (SELECT 1 FROM DubProbe dp WHERE dp.malId=a.malId AND dp.ok=1)
        )
        """
    ).fetchall()
    db.close()
    return rows


def main():
    rows = suspects()
    print(f"repairing {len(rows)} suspect shows…")
    fixed, still_missing, errors = [], [], []
    db = sqlite3.connect(DB)
    cur = db.cursor()
    for i, (mal, title) in enumerate(rows):
        out = fetch(mal, 1, "dub")
        if out and "error" not in out and out.get("src"):
            cur.execute(
                "UPDATE Anime SET hasDub=1, hasDubKiwi=1, updatedAt=? WHERE malId=?",
                (int(time.time() * 1000), mal),
            )
            fixed.append((mal, title))
            print(f"  FIXED {mal} {title[:44]}")
        elif out and out.get("error") == "no __P payload":
            still_missing.append((mal, title))
            print(f"  zoko-no-dub {mal} {title[:44]}")
        else:
            errors.append((mal, title, (out or {}).get("error", "?")))
            print(f"  probe-error {mal} {title[:40]} err={(out or {}).get('error','?')}")
        db.commit()
        time.sleep(0.4)
    db.close()
    summary = {
        "suspects": len(rows),
        "fixed": len(fixed),
        "zokoStillNoDub": len(still_missing),
        "probeErrors": len(errors),
        "fixedList": [m for m, _ in fixed],
        "stillMissingList": [{"malId": m, "title": t} for m, t in still_missing],
        "errorList": [{"malId": m, "title": t, "err": e} for m, t, e in errors],
    }
    with open("/home/z/my-project/scripts/dub-wipe-repair.json", "w") as f:
        json.dump(summary, f, indent=1)
    print(f"\nDONE: fixed={len(fixed)} noDubUpstream={len(still_missing)} errors={len(errors)}")


if __name__ == "__main__":
    main()
