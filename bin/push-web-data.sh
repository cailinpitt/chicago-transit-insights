#!/bin/sh
# Publish updated alert data to the R2 data origin and trigger a site rebuild.
#
# Replaces the old git-commit-to-Pages flow. The high-churn data files now live
# in R2 (served at https://data.chicagotransitalerts.app), so data refreshes no
# longer create commits or run a deploy. A rebuild is only needed to refresh the
# prerendered per-incident OG cards / feed — fired here as a GitHub
# repository_dispatch when the data actually changed, with the Actions schedule
# as the catch-up net.
#
# Invoked both by cron (catch-up) and event-driven (src/shared/webPushTrigger.js
# spawns it ~30s after a new Bluesky post). No-ops when the freshly exported data
# is byte-identical to the last successful upload, so neither the upload nor the
# rebuild fires on unchanged ticks.
#
# Env:
#   CTA_INSIGHTS          repo path (default: parent of this script's dir)
#   RCLONE_REMOTE         rclone remote:bucket (default: r2web:cta-alert-history-data)
#   DISPATCH_REPO         owner/repo to rebuild (default: cailinpitt/chicago-transit-alerts)
#   GITHUB_DISPATCH_TOKEN PAT allowed to POST repository_dispatch on DISPATCH_REPO.
#                         If unset, the upload still happens and a warning is
#                         logged — the scheduled rebuild will catch up.
set -e

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CTA_INSIGHTS="${CTA_INSIGHTS:-$(cd "$SCRIPT_DIR/.." && pwd)}"
REMOTE="${RCLONE_REMOTE:-r2web:cta-alert-history-data}"
DISPATCH_REPO="${DISPATCH_REPO:-cailinpitt/chicago-transit-alerts}"

# Pull GITHUB_DISPATCH_TOKEN from .env when it isn't already in the environment.
# The event-driven path inherits it via the bots' dotenv load, but the */15 cron
# line runs under plain /bin/sh (no dotenv), so without this the cron rebuild
# dispatch would never fire. Keep the token unquoted in .env.
if [ -z "${GITHUB_DISPATCH_TOKEN:-}" ] && [ -f "$CTA_INSIGHTS/.env" ]; then
  GITHUB_DISPATCH_TOKEN=$(grep -E '^GITHUB_DISPATCH_TOKEN=' "$CTA_INSIGHTS/.env" | head -1 | cut -d= -f2-)
fi

WORK="$CTA_INSIGHTS/tmp/web-data"
LAST="$WORK/.last"
mkdir -p "$WORK" "$LAST"

# healthchecks.io ping (optional; mirrors bin/cron-run.sh). The completion ping
# is fired from an EXIT trap so it covers every exit — the no-op "no change"
# exit, the normal end, and any set -e failure — meaning a quiet (unchanged) tick
# still counts as alive rather than looking silent. The exit code goes straight
# to healthchecks (0 = success, non-zero = failure). A "start" ping below lets
# healthchecks measure run duration as the gap between start and completion.
# No-op unless cron/healthchecks.env exists.
[ -f "$CTA_INSIGHTS/cron/healthchecks.env" ] && . "$CTA_INSIGHTS/cron/healthchecks.env"
hc_ping() {
  [ -n "${HC_PING_KEY:-}" ] || return 0
  # $1 = "start" or the exit code. ?create=1 auto-creates the check on its first
  # ping (no-op once it exists).
  curl -fsS -m 10 --retry 2 -X POST \
    "${HC_PING_URL:-https://hc-ping.com}/$HC_PING_KEY/push-web-data/$1?create=1" >/dev/null 2>&1 || true
}
trap 'hc_ping $?' EXIT
hc_ping start  # signal start for duration measurement

# 1. Export current data into the working dir (readonly DB read, cron-safe).
#    --shards also emits the bounded recent slice + monthly archive shards +
#    all-time per-line files + index + aggregates.json (precomputed YoY),
#    alongside the legacy full-history alerts.json (published side by side
#    during the rollout).
node "$CTA_INSIGHTS/bin/export-web.js" "$WORK/alerts.json" --shards "$WORK"
node "$CTA_INSIGHTS/bin/export-accessibility.js" "$WORK/accessibility.json"
node "$CTA_INSIGHTS/bin/export-daily.js" "$WORK/daily-counts.json"
node "$CTA_INSIGHTS/bin/export-csv.js" "$WORK/alerts.json" "$WORK/alerts.csv"

# 2. Change detection: bail if all files match the last successful upload.
changed=0
for f in alerts.json accessibility.json daily-counts.json alerts.csv; do
  if ! cmp -s "$WORK/$f" "$LAST/$f" 2>/dev/null; then
    changed=1
  fi
done
if [ "$changed" -eq 0 ]; then
  echo "push-web-data: no change, skipping upload + rebuild"
  exit 0
fi

# 2b. Publish floor. export-web.js has no lower bound of its own: pointed at a
#     fresh, empty, or half-restored DB it emits an alerts.json with almost no
#     incidents, and the rclone below would overwrite the live archive with it.
#     That is not recoverable from this side — the public site reads R2, not the
#     DB. So refuse to publish a sudden collapse in incident count, using the
#     last successful upload as the baseline.
#       PUSH_WEB_MIN_RATIO           floor as a % of baseline (default 80)
#       PUSH_WEB_ALLOW_NO_BASELINE=1 permit the first publish on a new host
#       PUSH_WEB_FORCE=1             publish anyway (a genuine mass deletion)
MIN_RATIO="${PUSH_WEB_MIN_RATIO:-80}"

count_incidents() {
  node -e '
    const Fs = require("node:fs");
    try {
      const d = JSON.parse(Fs.readFileSync(process.argv[1], "utf8"));
      console.log(Array.isArray(d.incidents) ? d.incidents.length : -1);
    } catch {
      console.log(-1);
    }
  ' "$1"
}

new_count=$(count_incidents "$WORK/alerts.json")
if [ "$new_count" -lt 0 ]; then
  echo "push-web-data: FATAL exported alerts.json is unreadable or has no incidents[]; refusing to publish" >&2
  exit 1
fi

if [ -f "$LAST/alerts.json" ]; then
  base_count=$(count_incidents "$LAST/alerts.json")
else
  base_count=-1
fi

if [ "$base_count" -lt 0 ]; then
  if [ "${PUSH_WEB_ALLOW_NO_BASELINE:-0}" != "1" ]; then
    echo "push-web-data: FATAL no baseline in $LAST — refusing to publish $new_count incidents." >&2
    echo "  This is the fresh-host case (new server, or tmp/ wiped). Confirm the restored DB is" >&2
    echo "  complete, then re-run once with PUSH_WEB_ALLOW_NO_BASELINE=1 to seed the baseline." >&2
    exit 1
  fi
  echo "push-web-data: no baseline; seeding with $new_count incidents (PUSH_WEB_ALLOW_NO_BASELINE=1)"
elif [ "$((new_count * 100))" -lt "$((base_count * MIN_RATIO))" ]; then
  if [ "${PUSH_WEB_FORCE:-0}" = "1" ]; then
    echo "push-web-data: incident count ${base_count} -> ${new_count} is below the ${MIN_RATIO}% floor; publishing anyway (PUSH_WEB_FORCE=1)."
  else
    echo "push-web-data: FATAL incident count collapsed ${base_count} -> ${new_count} (floor ${MIN_RATIO}%); refusing to publish." >&2
    echo "  Usually means the DB is fresh, half-restored, or HISTORY_DB_PATH points somewhere unexpected." >&2
    echo "  If the drop is real, re-run with PUSH_WEB_FORCE=1." >&2
    exit 1
  fi
fi

# 3. Upload to R2. High-churn files get a short edge-cache TTL; the client also
#    revalidates on generated_at / ETag, so 30s bounds worst-case staleness
#    without hammering origin. Closed-month archive shards get a long TTL since
#    they effectively never change once their month ends.
SHORT_TTL="Cache-Control: public, max-age=30"

# 3a. Short-TTL, high-churn top-level files (legacy full file + recent slice +
#     index + aggregates all change ~every tick; the existing
#     accessibility/daily/csv too).
for f in alerts.json accessibility.json daily-counts.json alerts.csv \
         alerts-recent.json alerts-index.json aggregates.json; do
  rclone copyto "$WORK/$f" "$REMOTE/$f" \
    --s3-no-check-bucket \
    --header-upload "$SHORT_TTL"
done

# 3b. All-time per-line files. Each changes only when its line gets a new
#     incident; rclone copy transfers just the files that actually differ, and
#     the client revalidates by ETag. Short TTL so a new incident shows promptly.
if [ -d "$WORK/incidents/by-line" ]; then
  rclone copy "$WORK/incidents/by-line" "$REMOTE/incidents/by-line" \
    --s3-no-check-bucket \
    --header-upload "$SHORT_TTL"
fi

# 3c. Monthly archive shards. The current Chicago month still grows each tick →
#     short TTL; every prior month is closed → a 1-day cache (safe even if a late
#     resolution rewrites an old shard, unlike a hard `immutable`; can tighten to
#     immutable once versioned-shard-URL handling lands). rclone copy never
#     deletes, and only re-transfers changed files.
if [ -d "$WORK/alerts" ]; then
  CUR_MONTH=$(TZ=America/Chicago date +%Y-%m)
  rclone copy "$WORK/alerts" "$REMOTE/alerts" \
    --exclude "${CUR_MONTH}.json" \
    --s3-no-check-bucket \
    --header-upload "Cache-Control: public, max-age=86400"
  if [ -f "$WORK/alerts/${CUR_MONTH}.json" ]; then
    rclone copyto "$WORK/alerts/${CUR_MONTH}.json" "$REMOTE/alerts/${CUR_MONTH}.json" \
      --s3-no-check-bucket \
      --header-upload "$SHORT_TTL"
  fi
fi

# Record the new baseline only after a successful upload. (Only the legacy
# top-level files gate change detection in step 2 — alerts.json reflects any
# incident change, so it already gates the shards too.)
cp "$WORK/alerts.json" "$LAST/alerts.json"
cp "$WORK/accessibility.json" "$LAST/accessibility.json"
cp "$WORK/daily-counts.json" "$LAST/daily-counts.json"
cp "$WORK/alerts.csv" "$LAST/alerts.csv"
echo "push-web-data: uploaded to $REMOTE"

# 4. Trigger a rebuild so prerendered OG cards pick up new
# incidents — debounced. alerts.json changes almost every tick, so an unthrottled
# dispatch fires a Pages deploy every 1-2 min, faster than Pages rolls them out,
# which wedges the public site on a stale build. The R2 upload above already ran
# (the client reads live data from R2, so the app stays current regardless); this
# only gates how often we rebuild the prerendered pages, which don't need
# minute-level freshness. Fire at most once per REBUILD_DEBOUNCE_SECONDS; the
# workflow's own schedule is the longer backstop.
DEBOUNCE="${REBUILD_DEBOUNCE_SECONDS:-900}"
STAMP="$LAST/.last-dispatch"
now_s=$(date +%s)
last_s=$(cat "$STAMP" 2>/dev/null || echo 0)
if [ -z "$GITHUB_DISPATCH_TOKEN" ]; then
  echo "push-web-data: GITHUB_DISPATCH_TOKEN unset; relying on scheduled rebuild"
elif [ "$((now_s - last_s))" -lt "$DEBOUNCE" ]; then
  echo "push-web-data: last rebuild $((now_s - last_s))s ago (< ${DEBOUNCE}s); debouncing dispatch"
else
  active_run=""
  for status in queued in_progress waiting pending requested; do
    runs_json=$(curl -fsS \
      -H "Authorization: Bearer $GITHUB_DISPATCH_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "https://api.github.com/repos/$DISPATCH_REPO/actions/workflows/deploy.yml/runs?status=$status&per_page=1") \
      || runs_json=""
    active_run=$(printf '%s' "$runs_json" | node -e '
      let body = "";
      process.stdin.on("data", (chunk) => (body += chunk));
      process.stdin.on("end", () => {
        try {
          const run = JSON.parse(body).workflow_runs?.[0];
          if (run) console.log(`${run.id} ${run.status} ${run.event}`);
        } catch (_) {}
      });
    ')
    if [ -n "$active_run" ]; then
      break
    fi
  done

  if [ -n "$active_run" ]; then
    echo "push-web-data: deploy workflow already active ($active_run); skipping dispatch"
    exit 0
  fi

  code=$(curl -fsS -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $GITHUB_DISPATCH_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/$DISPATCH_REPO/dispatches" \
    -d '{"event_type":"data-updated"}') || code="curl-failed"
  echo "push-web-data: repository_dispatch -> $DISPATCH_REPO (http $code)"
  [ "$code" = "204" ] && echo "$now_s" > "$STAMP"
fi
