#!/usr/bin/env python3
"""Extract the first clickable ref from an agent-browser snapshot file whose
line matches the regex. Snapshot lines look like:  - button "Search" [ref=e5]
and the ref is printed bare (e5) so callers can use @$REF."""
import re
import sys

path, pattern = sys.argv[1], sys.argv[2]
rx = re.compile(pattern, re.I)
with open(path) as f:
    for line in f:
        m = re.search(r"ref=e(\d+)", line)
        if m and rx.search(line):
            print(f"e{m.group(1)}")
            sys.exit(0)
print("")
