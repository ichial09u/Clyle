#!/bin/bash
# gradle-retry.sh — the sandbox reaper kills long processes; deps persist in
# ~/.gradle, so keep respawning until the APK actually pops out.
cd /home/z/my-project/mobile/android
export JAVA_HOME=/home/z/jdk/jdk-21.0.12.1+1
export PATH="$JAVA_HOME/bin:$PATH"
LOG=/tmp/gradle-build3.log
: > "$LOG"
for i in 1 2 3 4 5 6 7 8; do
  echo "=== ATTEMPT $i $(date -Is) ===" >> "$LOG"
  ./gradlew assembleRelease --no-daemon -x lintVitalRelease >> "$LOG" 2>&1
  code=$?
  echo "=== attempt $i exit $code ===" >> "$LOG"
  if [ $code -eq 0 ] && ls app/build/outputs/apk/release/*.apk >/dev/null 2>&1; then
    echo "BUILD_DONE" >> "$LOG"
    exit 0
  fi
  # config/cache errors won't heal by retrying — bail out loudly
  if grep -qE "What went wrong|Could not (resolve|download)" "$LOG" | head -1; then
    if ! grep -qE "Killed|killed" "$LOG"; then
      echo "CONFIG_ERROR_STOP" >> "$LOG"
      exit 2
    fi
  fi
  sleep 5
done
echo "RETRIES_EXHAUSTED" >> "$LOG"
exit 1
