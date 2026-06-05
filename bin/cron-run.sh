#!/bin/bash
# Usage: cron-run.sh <log-name> <script> [args...]
# Runs `node <script> <args...>` from the repo root, appending stamped output
# to cron/<log-name>-cron.log. Exists so crontab entries don't each repeat the
# cd/printf/redirect boilerplate.
set -e
cd "$(dirname "$0")/.."
NAME=$1
SCRIPT=$2
shift 2
LOG=cron/$NAME-cron.log
printf "\n\n=== $(date) $NAME ===\n" >> "$LOG"

# healthchecks.io monitoring (optional). Only the slugs in HC_MONITORED ping
# (and thus auto-create a check); the curated set keeps us under the 20-check
# free tier and is the committed source of truth for "what's watched" — edit it
# here and `git pull` on the server to widen/narrow coverage. Jobs not listed
# simply don't ping. (push-web-data isn't run via this wrapper; it pings from
# its own script.) No-op entirely unless cron/healthchecks.env exists (see the
# .example).
HC_MONITORED="observe-buses observe-trains bus-alerts bus-pulse train-alerts train-pulse bus-bunching bus-gaps bus-ghosts bus-thin-gaps train-bunching train-gaps train-ghosts bus-speedmap train-speedmap fetch-gtfs audit-alerts export-event-tracks"
[ -f cron/healthchecks.env ] && . cron/healthchecks.env
case " $HC_MONITORED " in *" $NAME "*) hc_watched=1 ;; *) hc_watched= ;; esac

# $1 = endpoint suffix: "start" before the run, the exit code after. healthchecks
# measures run duration as the gap between the start and completion pings, and
# treats a non-zero exit code as failure (so a job that ran but crashed alerts
# too). -m caps curl so a hung ping never wedges the cron slot; pings are never
# fatal to the job. ?create=1 auto-creates the check on first ping (no-op once it
# exists; see cron/healthchecks.env.example for tuning the auto-created defaults).
hc_ping() {
  [ -n "$HC_PING_KEY" ] && [ -n "$hc_watched" ] || return 0
  curl -fsS -m 10 --retry 2 -X POST \
    "${HC_PING_URL:-https://hc-ping.com}/$HC_PING_KEY/$NAME/$1?create=1" >/dev/null 2>&1 || true
}

# Signal start so healthchecks can time the run, then relax -e so a non-zero exit
# still sends the completion ping instead of aborting the wrapper before it.
hc_ping start
set +e
/usr/bin/node "$SCRIPT" "$@" >> "$LOG" 2>&1
rc=$?
hc_ping "$rc"

exit $rc
