# Vehicle position archive

Every CTA bus, CTA train and Metra position we poll enters `observations`.
SQLite keeps a **14-day hot window**; completed Chicago calendar days are
archived as **Parquet only**, one file per feed/day/revision. The new contract
below takes effect when the operator completes the cutover; deploying this
code alone does not migrate the public archive.

## Format and layout

- Sort order: **`route, vehicle_id, ts`**, ascending; identifiers sort as strings.
- ZSTD level 3; requested row groups of 122,880 rows; no outer gzip wrapper.
- Explicit types: identifiers/dates are strings, timestamps and integer fields
  are `BIGINT`, coordinates and `pdist` are `DOUBLE`. Coordinates are not rounded.
- Original fields, nulls and duplicate multiplicities are retained. Earlier
  train files gain nulls for later nullable fields. Legacy Metra `vehicle_ts`
  seconds are normalized to milliseconds, as in the previous exporter; the
  migration ledger counts those changes. `ts` is poll time; `vehicle_ts` is
  the source position time. Both use epoch milliseconds.
- `sched_start_date` is **YYYY-MM-DD**, separate from the archive calendar day;
  `sched_start_sec` may exceed 86,400.
- Partitions run midnight to midnight in `America/Chicago`, including 23/25-hour
  DST days. Archive dates start at 2026-09-28. These are calendar days, not
  necessarily scheduled service dates.
- Latitude and longitude are retained as scalar columns. Geometry is constructed
  by GIS consumers when needed. This selects the smallest measured layout;
  [benchmark results](POSITIONS_BENCHMARK.md) explain the GeoParquet tradeoff.

Files have content-addressed URLs:

```text
https://data.chicagotransitalerts.app/positions/{bus,train,metra}/YYYY/MM/YYYY-MM-DD.{sha256}.parquet
```

A correction produces a new path; old Parquet objects and manifests remain
available. `--reexport-date` records the replaced path/checksum. Do not remove
old Parquet revisions with bucket lifecycle rules.

## Discovery and reproducible downloads

`https://data.chicagotransitalerts.app/positions/index.json` becomes a small
**version-2 pointer**, rather than the old index's list of days:

```json
{
  "manifest_version": 2,
  "path": "positions/manifests/<sha256>.json",
  "sha256": "<sha256>",
  "bytes": 12345
}
```

Resolve `path` relative to `https://data.chicagotransitalerts.app/`, verify its
bytes/checksum, then read the immutable manifest. It has `manifest_version: 2`,
`schema_version: 2`, `format: "parquet"`, `compression: "zstd"`, `sort_order`,
`previous_manifest`, `base_url`, `coverage`, `feeds`, `known_gaps` and `days`
(newest first). Field types, units, nullability and introduction dates remain
in `feeds`; see `SCHEMA` in `src/shared/positionsArchive.js`.

Each day has `date`, `weekday`, per-feed `rows`, and `files`. Each file records
`path`, `format`, `schema_version`, `data_revision` (the SHA-256), `sha256`,
`bytes`, `rows`, `ts_min`, `ts_max`, `vehicle_ts_min`, `vehicle_ts_max`, `writer`
and `quality`. Time bounds are inclusive observed extrema, null for no values.
Quality contains distinct poll times, invalid/missing coordinate row counts,
and train `approx: 1` row counts. Empty feeds still have a typed Parquet file.
These counts describe recorded data; they do not assert polling completeness.

Pin the immutable manifest URL for repeatable analysis. Never glob all Parquet
objects for a day: a directory may contain superseded revisions. The public
manifest lists one canonical object per feed/day.

Python download and checksum verification (after cutover):

```python
import hashlib
import json
from pathlib import Path
from urllib.request import Request, urlopen
import pandas as pd

base = "https://data.chicagotransitalerts.app/"
def fetch(path):
    request = Request(base + path, headers={"User-Agent": "positions-parquet-example/1"})
    with urlopen(request) as response:
        return response.read()

def verified_bytes(file):
    body = fetch(file["path"])
    assert len(body) == file["bytes"]
    assert hashlib.sha256(body).hexdigest() == file["sha256"]
    return body

pointer = json.loads(fetch("positions/index.json"))
assert pointer["manifest_version"] == 2
manifest = json.loads(verified_bytes(pointer))
file = manifest["days"][0]["files"]["bus"]
Path("bus.parquet").write_bytes(verified_bytes(file))
df = pd.read_parquet("bus.parquet", columns=["route", "vehicle_id", "ts", "lat", "lon"])
```

Install `pandas` and `pyarrow` for this example. For large files, stream downloads
and hashing instead of retaining the downloaded bytes in memory.

DuckDB CLI against that local file (or a manifest-selected HTTPS URL):

```sql
SELECT route, vehicle_id, to_timestamp(ts / 1000.0) AS poll_time, lat, lon
FROM read_parquet('bus.parquet')
WHERE route = '66'
ORDER BY vehicle_id, ts
LIMIT 20;
```

An HTTP reader can fetch selected columns and skip row groups using statistics;
actual savings depend on the query and host. Route/vehicle/time order favors
trajectories and compression. A short time window across all routes or an area
query can still touch many groups. Geometry alone would not add a spatial index.

GIS consumers can construct points with GeoPandas (longitude first):

```python
import geopandas as gpd
valid = df["lat"].between(-90, 90) & df["lon"].between(-180, 180)
gdf = gpd.GeoDataFrame(
    df.loc[valid].copy(),
    geometry=gpd.points_from_xy(df.loc[valid, "lon"], df.loc[valid, "lat"]),
    crs="OGC:CRS84",
)
```

For trains, load and retain `approx`; filter `approx == 0` when exact positions
are required. Constructing a point does not make a station substitute a measured
position.

## Collection caveats

- Buses and Metra are polled about every 30 seconds, and trains at least
  every 30 seconds. Other jobs poll trains in between, so train snapshots
  are often closer together. Older bus files were polled about once a minute.
- Train rows with `approx: 1` had no usable lat/lon in the feed, so the
  position was filled in from the next station. Leave them out for anything
  that relies on exact positions.
- Train Tracker never gives a position for Howard-bound Yellow Line trains
  (direction 5). They all come back as `approx: 1` pinned at Oakton-Skokie
  for the whole trip, which is about half of all Yellow rows. Only
  Skokie-bound Yellow positions are real.
- Train Tracker positions are sometimes wrong, so position changes between
  consecutive rows can imply impossible speeds (over 90 mph). Two causes:
  the feed sometimes reports the next station's coordinates instead of the
  train's (seen often on the Blue Line near O'Hare, flipping back and forth
  every poll), and some train rows are only a few seconds apart, which
  turns small position noise into large speeds. Filter or smooth before
  computing train speeds. From 2026-11-01, train rows also carry `heading`,
  `vehicle_ts` (when Train Tracker generated the position) and `approaching`,
  which help spot these jumps. They are null in earlier files.
- `vehicle_id` is only unique within a `route`. Train run numbers repeat
  across lines (run 1000 can be on Green and Purple at once), and Metra train
  numbers repeat across lines (often ME and UP-N). Key vehicles on
  `(route, vehicle_id)`, or `trip_id` for Metra.
- Metra's feed occasionally lists the same trip twice in one poll, with one
  copy stuck at an old position (about 7 a day). Deduplicate on
  `(ts, trip_id)`, keeping the row whose position changes.

### Known gaps

Times are Chicago time. Missing polls mean missing rows, not reduced
service, so leave these windows out of fleet and headway counts. The same
list is in the index as `known_gaps`; keep this table in sync with
`KNOWN_GAPS` (a test checks).

| Date | Kinds | Missing | Note |
|---|---|---|---|
| 2026-10-12 | bus | 18:03 to midnight | CTA Bus Tracker daily request limit hit; data unrecoverable |
| 2026-10-13 | bus | 14:30 to midnight | CTA Bus Tracker daily request limit hit; data unrecoverable |
| 2026-10-14 | bus | 13:34 to midnight | CTA Bus Tracker daily request limit hit; data unrecoverable |
| 2026-10-15 | bus | 13:13 to midnight | CTA Bus Tracker daily request limit hit; data unrecoverable |
| 2026-10-16 | bus | 13:19 to midnight | CTA Bus Tracker daily request limit hit; data unrecoverable |
| 2026-10-17 | bus | 15:51 to midnight | CTA Bus Tracker daily request limit hit; data unrecoverable |
| 2026-10-22 | bus, train, metra | 15:37 to 15:48 | No polls recorded |
| 2026-10-30 | bus, train, metra | 17:40 to 18:07 | No polls recorded |
| 2026-11-03 | bus, train, metra | 15:28 to 15:29 | Dependency reinstall during deploy |
| 2026-11-04 | bus, train, metra | 09:00 to midnight | Reduced polling: stuck DB backups caused lock contention that dropped some polls |
| 2026-11-05 | bus, train, metra | 00:00 to 01:00 | Reduced polling: stuck DB backups caused lock contention that dropped some polls |
| 2026-11-05 | bus, train, metra | 06:00 to 14:36 | Reduced polling: stuck DB backups caused lock contention that dropped some polls |
| 2026-11-05 | bus, train, metra | 14:36 to 16:37 | Server ran out of memory and hung; no polls recorded |

Metra has no rows overnight (roughly 01:00 to 04:30) because no trains are
running; that isn't a gap.

## Daily publication and retention

`bin/export-positions.js` runs at 02:40, before the 04:17 database backup.
It reads completed days directly from SQLite with `better-sqlite3`, appends typed
rows to a disk-backed DuckDB staging database, and sorts/writes Parquet. The
pinned `@duckdb/node-api` release bundles DuckDB; production needs no external
DuckDB CLI, extension download, query service or NDJSON intermediate.

The writer uses one thread and a `256MB` DuckDB memory limit (override with
`POSITIONS_MEMORY_LIMIT`). This is a DuckDB buffer limit, not a total process RSS
limit. Leave disk space for staging/spill and the permanent archive; process
feeds/days sequentially. Validate resources on the deployment host.

1. Validate schema and partition boundaries. Write into a temporary directory.
2. Read back each file and compare every field with **symmetric `EXCEPT ALL`**,
   including duplicate multiplicity. Validate schema metadata, hash and rename
   the completed output to its immutable path.
3. Persist pending state. Upload every feed, then stream remote bytes through
   SHA-256 and size checks. ETags are not treated as SHA-256.
4. Upload and verify an immutable manifest. Update and verify `index.json`
   **last**, then persist the day's committed state.
5. Delete old observations in hourly batches, stopping at the first day lacking
   all three verified Parquet files and a committed manifest. An upload or
   publication error aborts before deletion. Pending publication is retried
   even when the next run has no new days.

Parquet and immutable manifests use one-year immutable caching. The latest
pointer uses a five-minute cache. Parquet is served as
`application/vnd.apache.parquet` without `Content-Encoding: gzip`.

```sh
npm run export-positions:dry           # scratch outputs; no upload or DB/state change
node bin/export-positions.js --limit 3 # at most three unfinished days
node bin/export-positions.js --publish-index
node bin/export-positions.js --reexport-date 2026-11-01
```

Corrections from SQLite are limited to completed days still inside the 14-day
hot window; older data cannot be rebuilt from a pruned table. For older revisions,
restore the complete source into a separate database and implement/validate the
correction before publication; do not remove manifest entries to force a re-export.
The former in-place `scripts/fix-metra-vehicle-ts.js` repair is retired.

Overrides remain `HISTORY_DB_PATH`, `POSITIONS_MANIFEST_PATH`,
`POSITIONS_ARCHIVE_DIR` and `RCLONE_REMOTE`. Daily export and migration share an
exclusive `<manifest path>.lock`. After a hard crash, confirm the recorded PID
is gone and no exporter/migration is running before removing a stale lock and
retrying. Corrupt, missing or legacy state fails closed; restore it rather than
silently rebuilding pruned history as empty files. An intentionally new archive
with a complete SQLite history can initialize its state to
`{"manifest_version":2,"days":{},"published":null}`. Existing archives must migrate.

## One-time migration and cutover

This is a breaking distribution change. The operator coordinates the date and
updates subscription/download UI code and consumers outside this repository.
Do not activate the new daily cron against the old manifest until migration
succeeds. Pause the old daily exporter while migrating; observers can continue.
The migration does not prune SQLite.

```sh
npm ci
npm run migrate-positions                    # stage and verify historical Parquet
npm run migrate-positions -- --cutover        # verify all replacements; switch index last
npm run export-positions                     # catch up completed days; enable nightly cron
# After updating public links/consumers and verifying the public host:
npm run migrate-positions -- --retire-ndjson
```

The first command inventories **both** the local legacy manifest and published
index, including published days absent from local state. It downloads missing
inputs from the configured bucket, checks original size/SHA-256/row count, streams
conversion, and rejects unexpected fields. It preserves the old index until
`--cutover`. Progress is saved in `<manifest path>.parquet-migration`; retries
reuse validated outputs. A `<manifest path>.ndjson-backup` preserves the old
metadata, while the new state's per-day `sources` ledger records input and destination checksums,
validation and timestamp-normalization counts. Metadata backups are not parallel
NDJSON archives.

The matching legacy index is saved as `archive/positions/index.ndjson-backup.json`
(under `POSITIONS_ARCHIVE_DIR` when overridden), including days found only in the
published index. Keep both metadata backups through the cutover.

Retirement verifies the published manifest and each Parquet replacement again
before deleting the corresponding old `.ndjson.gz` object and local file. It is
resumable and records retirement in the ledger. It never deletes superseded
Parquet revisions. Remove old links and purge or expire cached NDJSON responses
at the CDN; old endpoints should disappear, not return Parquet under a `.gz` URL.
No new daily NDJSON producer remains after this change.

Before retiring inputs, test the **actual public Parquet URL** with HEAD, a
`Range: bytes=0-3` GET (expect `206` and `PAR1`), and a remote DuckDB query. For
browser consumers check CORS and exposure of `Accept-Ranges`, `Content-Range`,
`Content-Length` and `ETag`; disable transformations/outer compression. The PR's
local writer tests and simulated upload failures do not establish production
CDN or R2 configuration. Related client access compatibility is tracked in #4.

If staging fails, rerun it after fixing the cause; the old index and inputs are
intact. If the latest-pointer upload succeeds but verification/state saving
fails, rerun `--cutover`: it recognizes the new pointer and completes state.
Before retirement, rolling back the cutover requires restoring the old manifest,
its matching old index and old exporter together. After retirement, restore from
Parquet; do not restart the legacy exporter over pruned SQLite history.

The DB backup excludes `observations` ([BACKUPS.md](BACKUPS.md)); the verified
object archive is their off-box copy. Keep local manifest state backed up too.
Backfill/render scripts that query old incidents in SQLite still only work
inside the hot window; load manifest-selected Parquet files for older data.
