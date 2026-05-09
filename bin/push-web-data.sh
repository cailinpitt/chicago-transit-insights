#!/bin/sh
# Push updated alert data to the GitHub Pages repo.
# Only commits when the data actually changed.
#
# Required env or edit defaults below:
#   PAGES_REPO  — path to the cta-alert-history clone (default: ~/cta-alert-history)
#   CTA_INSIGHTS — path to this repo clone (default: ~/cta-insights)

set -e

PAGES_REPO="${PAGES_REPO:-$HOME/cta-alert-history}"
CTA_INSIGHTS="${CTA_INSIGHTS:-$HOME/cta-insights}"

cd "$PAGES_REPO"
git pull --quiet

node "$CTA_INSIGHTS/bin/export-web.js" public/data/alerts.json
node "$CTA_INSIGHTS/bin/export-daily.js" public/data/daily-counts.json

# Commit if either file is modified or newly created. `git status --porcelain`
# catches both cases (`git diff --quiet` would miss the first-ever creation of
# daily-counts.json since untracked files don't show up in the diff).
if [ -z "$(git status --porcelain public/data/alerts.json public/data/daily-counts.json)" ]; then
  echo "push-web-data: no changes, skipping commit"
  exit 0
fi

git add public/data/alerts.json public/data/daily-counts.json
git -c user.name="cta-bot" -c user.email="cta-bot@users.noreply.github.com" \
  commit -m "data: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push
echo "push-web-data: pushed"
