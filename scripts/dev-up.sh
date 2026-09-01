#!/bin/bash
# Start the Next dev server if it isn't already answering, then wait for readiness.
# Usage: bash scripts/dev-up.sh [timeout-seconds]
set -u
cd /home/z/my-project

TIMEOUT="${1:-60}"
CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ --max-time 5 2>/dev/null || true)
if [ "$CODE" = "200" ]; then
  echo "dev server already up"
  exit 0
fi

# double-fork so the server survives this shell
python3 - <<'PY'
import os, sys
pid = os.fork()
if pid == 0:
    os.setsid()
    try:
        pid2 = os.fork()
    except OSError:
        os._exit(1)
    if pid2 == 0:
        os.chdir("/home/z/my-project")
        devnull = os.open(os.devnull, os.O_RDWR)
        os.dup2(devnull, 0); os.dup2(devnull, 1); os.dup2(devnull, 2)
        os.execvp("bun", ["bun", "run", "dev"])
    os._exit(0)
try:
    os.waitpid(pid, 0)
except ChildProcessError:
    pass
PY

for i in $(seq 1 "$TIMEOUT"); do
  sleep 1
  CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ --max-time 5 2>/dev/null || true)
  if [ "$CODE" = "200" ]; then
    echo "dev server up after ~${i}s"
    exit 0
  fi
done
echo "dev server FAILED to come up within ${TIMEOUT}s (last status: $CODE)"
tail -8 dev.log 2>/dev/null
exit 1
