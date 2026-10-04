# Event replay (position tracks)

Every train incident on [chicagotransitalerts.app](https://chicagotransitalerts.app)
gets a **"▶ Watch it unfold"** player on its event page that animates the actual
train positions across the line schematic — you watch the stretch go cold and
the trains pile up, then recover. The frontend component is `EventReplay.jsx`
(in the `cta-alert-history` repo); this doc covers the server side that feeds it.

## The problem it solves

The raw positions live in `observations` on the server, which the public site
can't read. Incidents, though, keep a permanent permalink (90-day timeline + an
`/event/:id` page for each). The fix: **archive each incident's position window
to R2**, keyed by the incident's permalink id.

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

**Turnaround legs (`id` suffixes).** A run number (`rn`) reverses direction at a
terminal under the *same* `rn`. Merged into one track, the player's monotonic
de-jitter would drop the entire return leg (every "backward" sample), so the
train appears to vanish and teleport. `buildTrack` therefore **splits a vehicle
at a sustained direction change** (`segmentByDirection`): the outbound leg keeps
the bare `rn` as its `id`, the return leg becomes `<rn>~1` (then `~2`…). Each leg
is a single-direction track that fades out at the terminal and back in on the
return — which is what actually happened. The legs are time-disjoint, so the
"N trains on the line" readout never double-counts. A 1-ping opposite-direction
blip (CTA `trDr` noise) is absorbed, not split.

Pure builders + the replayable/affected-dir logic: `src/shared/eventTracks.js`
(unit-tested in `test/shared/eventTracks.test.js`). The bin
(`bin/export-event-tracks.js`) is thin wiring: load alerts.json → query
positions → `buildTrack` → gzip → rclone. The position query `ORDER BY ts` (and
`buildTrack` re-sorts defensively) so segmentation and the relative-second keys
are correct regardless of row order.

## Why trains seem to vanish — and what we do about it

Most "the train dropped and reappeared" moments are the CTA feed, not the
player. Three causes and their mitigations:

1. **The feed drops a train for a stretch, then resumes** (GPS loss, tunnels,
   prediction suppression near terminals/yards). The player **bridges gaps up to
   8 min** (`MAX_GAP_SEC`), interpolating straight through (dimmed by staleness)
   since the train really is still running. Past 8 min it fades to a parked
   ghost on each side and draws nothing through the unknown middle — we genuinely
   don't know where it was.
2. **The feed returns a train at `lat/lon = 0,0`** (unpositioned, a known CTA
   glitch). Rather than dropping it — which manufactures a feed gap out of a
   train that's present and locatable — `getAllTrainPositions` **recovers an
   approximate position from the train's `nextStaNm`** (station coords) and
   records it tagged `approx`. These recovered points flow into the track, so
   the replay stays continuous across the dropout. They are kept **out of the
   ghost/gap/pulse detectors** (those reads filter `approx`), so detection counts
   are unchanged. See `recoverUnpositionedTrain` in `src/train/api.js`.
3. **A train ends its run vs. the feed loses it mid-route.** Both used to look
   identical (a silent fade-out). The player now tells them apart: a stream that
   ends near a terminus (or the Loop, for round-trip lines) is a clean exit; one
   that ends mid-route before the incident resolves gets a brief fading **"signal
   lost" ring** at its last spot, so a data gap reads as a data gap.

The server-rendered timelapses (train bunching/gap/system-snapshot and bus
bunching) share the same model via the **`src/shared/videoTracks.js`** kernel:
bridge short gaps, ghost long/tail drops (dead-reckoned along the polyline),
play a turnaround glyph at real terminals. Before it, the train clips only
ghosted trains missing from the *final* frame, so a mid-clip dropout hard-
disappeared and popped back in; the bus clip bridged interior gaps but with no
cap. One kernel now covers all four surfaces plus this replay.

## What gets archived

Train incidents with a resolvable single line **and** a two-station segment
(`from` + `to`), whose `onset` is within the lookback window (default 6.5 days,
`--window-days` to widen). A **manifest** (`state/track-manifest.json`)
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
artifact). First live run backfills every replayable incident inside the
lookback window.
