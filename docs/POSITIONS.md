# Vehicle position archive

Every CTA bus, CTA train and Metra position we poll is written to the
`observations` table. The table only keeps a **14-day hot window**, enough for
every detector (the longest lookback is 7 days) and for
`export-event-tracks` (6.5 days). Older days live in a daily file archive that
is also published for anyone to download.

## Getting the data

Index: <https://data.chicagotransitalerts.app/positions/index.json>

The index lists every archived day with each file's path, row count, size and
sha256, plus the field list for each kind. Files are at:

```
https://data.chicagotransitalerts.app/positions/{bus,train,metra}/YYYY/MM/YYYY-MM-DD.ndjson.gz
```

- One file per kind per Chicago service day (midnight to midnight
  `America/Chicago`), starting 2026-09-28.
- Gzipped NDJSON: one JSON object per line, ordered by `ts`.
- `ts` is when we polled the feed (epoch ms). `vehicle_ts`, where present, is
  the feed's own timestamp for that position.
- Buses and Metra are polled about every 30 seconds, and trains at least
  every 30 seconds. Other jobs poll trains in between, so train snapshots
  are often closer together. Older bus files were polled about once a minute.
- Train rows with `approx: 1` had no usable lat/lon in the feed, so the
  position was filled in from the next station. Leave them out for anything
  that relies on exact positions.

```sh
curl -sO https://data.chicagotransitalerts.app/positions/train/2026/10/2026-10-30.ndjson.gz
gzip -dc 2026-10-30.ndjson.gz | head
```

```python
import pandas as pd
df = pd.read_json("https://data.chicagotransitalerts.app/positions/bus/2026/10/2026-10-30.ndjson.gz", lines=True)
```

## How it runs

`bin/export-positions.js` runs nightly at 02:40 (`cron/crontab.txt`), before
the 04:17 DB backup:

1. For each finished day since 2026-09-28 that isn't uploaded yet, it reads
   the day from `observations` in a single pass and writes one file per kind
   to `archive/positions/` (the permanent copy on the server).
2. It uploads the files to `r2web:cta-alert-history-data/positions/` and
   records them in `state/positions-manifest.json`. `positions/index.json` is
   rebuilt from the manifest.
3. It deletes `observations` rows older than 14 days, but never past the first
   day that isn't uploaded yet. A failed run leaves the data in the DB for the
   next night.

Finished days never change, so a day is exported once. To re-export one,
delete its entry from the manifest and its files from `archive/positions/`.

```sh
npm run export-positions:dry           # write to tmp/positions-dry-run, no upload or delete
node bin/export-positions.js --limit 3 # export at most 3 days this run
node bin/export-positions.js --publish-index  # re-upload index.json only
```

The DB backup leaves `observations` out (`docs/BACKUPS.md`); the R2 copy of
the archive is the off-box backup for positions.

Scripts that read `observations` for old incidents (`bin/backfill-*`,
`scripts/render-*`, `scripts/export-*-fixture*`) only work inside the hot
window now. For anything older, load the archive files.
