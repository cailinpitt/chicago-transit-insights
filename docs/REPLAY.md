# Event replay (position tracks)

Every train incident on [chicagotransitalerts.app](https://chicagotransitalerts.app)
gets a **"▶ Watch it unfold"** player on its event page that animates the actual
train positions across the line schematic — you watch the stretch go cold and
the trains pile up, then recover. The frontend component is `EventReplay.jsx`
(in the `cta-alert-history` repo); this doc covers the server side that feeds it.

## The problem it solves

The raw positions live in `observations`, which **rolls off after 7 days**
(`src/shared/observations.js`). Incidents, though, keep a permanent permalink
(90-day timeline + an `/event/:id` page for each). So a replay can't read the
live DB — for anything older than a week the positions are already gone. The
fix: **archive each incident's position window to R2 before it rolls off**,
keyed by the incident's permalink id.

## Data flow

```
cta-insights (server)                          R2 (data.chicagotransitalerts.app)     cta-alert-history (frontend)
─────────────────────                          ──────────────────────────────────     ────────────────────────────
bin/export-event-tracks.js  (cron, every 15m)
  read tmp/web-data/alerts.json  ──────────────►  (authoritative event ids + segments)
  read observations (positions) for each
    replayable train incident in window
  build compact track, gzip
  rclone ──►  tracks/<eventId>.json (gzip)  ───►  GET tracks/<eventId>.json  ◄──── EventReplay fetches on Play
```

The archiver is **driven off the published `alerts.json`**, not a re-derivation
of incidents from the DB. That's deliberate: the event `id` is a Bluesky rkey
(the *alert's* rkey for CTA-paired incidents, the observation's for bot-only),
and `alerts.json` already carries the canonical id plus the segment / direction
fields. Reading it guarantees a track's key matches the page that fetches it,
with zero duplication of `export-web.js`'s pairing logic. The DB is touched only
for raw positions.

## Track file shape (`tracks/<eventId>.json`)

```json
{ "eventId": "3mnebtsoe7n2d", "line": "orange",
  "from": "35th/Archer", "to": "Ashland (Orange)", "stations": [...],
  "onset": 1780153502245, "resolved": 1780155002912,
  "affectedDir": "1",                      // CTA dir code of the cold direction (see below)
  "t0": …, "t1": …, "durSec": 4349,
  "vehicles": [ { "id": "721", "dir": "1", "s": [[tSec, lat, lon], …] } ] }
```

Samples are relative seconds from `t0` with 5-dp coords → ~22 KB raw, **~4 KB
gzipped** (stored gzipped with `Content-Encoding: gzip`; browsers decode
transparently). `affectedDir` lets the player color the segment red off the
*affected* direction's presence, so an opposite-direction train passing through
a one-directional cold doesn't clear it. It's resolved by matching the
direction label's terminus ("toward the Loop") to the `dir` whose trains are
**destined** there (destination text is authoritative; null = undirected, and
the player falls back to any-direction occupancy).

Pure builders + the replayable/affected-dir logic: `src/shared/eventTracks.js`
(unit-tested in `test/shared/eventTracks.test.js`). The bin
(`bin/export-event-tracks.js`) is thin wiring: load alerts.json → query
positions → `buildTrack` → gzip → rclone.

## What gets archived

Train incidents with a resolvable single line **and** a two-station segment
(`from` + `to`), whose `onset` is within the retention window (default 6.5 days,
safely inside the 7-day rolloff). A **manifest** (`state/track-manifest.json`)
records which incidents have been archived after they resolved; those are
immutable and skipped. Active incidents re-upload each run until they resolve
(capturing the recovery), then finalize. Bus incidents (no schematic) and
segment-less incidents are skipped.

## Storage

One small object per train incident, **never expired** — a track should live as
long as its (permanent) event page. At ~6 train incidents/day that's ~9 MB/year
gzipped, decades of runway on R2's 10 GB free tier. Uploads are bounded by the
manifest to active + newly-resolved incidents, so Class-A op churn stays tiny.

## Schedule

`9-59/15` via `bin/cron-run.sh` (see `cron/crontab.txt`) — offset to `:09` so it
runs after the `:00/:15` `push-web-data.sh` refreshes `tmp/web-data/alerts.json`.
Reuses the existing **`r2web`** rclone remote (same as the data push / backups)
— no new credentials. healthchecks.io ping comes from `cron-run.sh` under the
`export-event-tracks` slug.

## Dev / validation

```sh
npm run event-tracks:dry          # build tracks into tmp/event-tracks/, upload nothing
node bin/export-event-tracks.js --dry-run --event=<rkey>   # one incident
node bin/export-event-tracks.js --dry-run --alerts=/path/to/alerts.json
```

A dry run reads the live DB but writes only local files and leaves the manifest
untouched. Run it on the server (the laptop's `history.sqlite` is a stale dev
artifact). First live run backfills every replayable incident still inside the
7-day window.
