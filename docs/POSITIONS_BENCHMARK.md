# Sorted Parquet archive benchmark

Measured November 1, 2026, against the published October 27 bus, train and Metra
files. The chosen layout is **route, vehicle_id, ts**, ZSTD level 3, row groups
of 122,880, with scalar latitude/longitude and no geometry column. This was the
smallest of the three tested orders for **each** feed.

| Feed | Rows | NDJSON.gz bytes | Source-order Parquet | Route/time/vehicle Parquet | Route/vehicle/time Parquet | Reduction vs gzip |
|---|---:|---:|---:|---:|---:|---:|
| Bus | 1,069,625 | 38,819,392 | 16,915,757 | 15,830,877 | **13,424,677** | **65.42%** |
| Train | 304,912 | 2,569,195 | 1,349,634 | 1,080,405 | **737,019** | **71.31%** |
| Metra | 112,456 | 2,335,354 | 914,201 | 973,377 | **757,422** | **67.57%** |

The bus, train and Metra outputs have nine, three and one row groups respectively.
There are **1,486,993 observations** in total. All three canonical files passed
symmetric `EXCEPT ALL` against the writer's typed input relations: zero different
rows, including duplicate multiplicity. The tests separately check input mapping,
nulls, leading-zero identifiers, fractional `pdist`, coordinate precision, physical
sort order, timestamps, and DST boundaries.

Switching the writer from the npm bindings to the **standalone DuckDB CLI**
produced **byte-for-byte identical canonical files for all three feeds**: every
output SHA-256 matches the original PR implementation at `65376ad`. There are
no new npm dependencies; the server installs the pinned CLI once.

An initial WKB GeoParquet prototype retained latitude/longitude and added a
21-byte point per usable coordinate. Its sorted bus file was **20,281,917 bytes**
(the other feeds were 954,674 and 1,167,958). The selected scalar layout avoids
that geometry duplication. GIS consumers can construct points as shown in
[POSITIONS.md](POSITIONS.md). The geometry prototype is not a second production
format. This narrows the initial GeoParquet suggestion in issue #5 to prioritize
the requested smallest sorted artifact.

The original issue's 13,305,273-byte bus result used a development DuckDB build,
four threads, and `pdist: BIGINT`. This implementation uses the pinned stable
DuckDB 2.0.0 writer, one thread, and `pdist: DOUBLE` to preserve its declared
numeric schema and fractional values. It adds schema-version footer metadata.
Do not expect identical sizes across schemas or writer versions.

## Environment and scope

- Node **22.23.4**, standalone DuckDB CLI **v2.0.0** (`d54cbbe3df`), macOS/arm64.
- The production writer plus read-back validation took **11.67 seconds** with a
  **256MB DuckDB memory limit**. Node reported **131,040 KiB peak RSS**, but this
  measures **only the Node parent, excluding the DuckDB child**; it is not a
  total-memory measurement or a comparison with the previous in-process writer.
  The timed section includes parsing the historical inputs, temporary CSV
  staging, sorting and validation, before the alternate-order benchmarks.
  The DuckDB buffer limit is not an RSS cap. This is one local run, not a
  throughput guarantee or a comparison with the old exporter.
- Inputs were already on local disk. Every feed passed independent PyArrow
  **26.0.0** checks for physical column types, schema metadata and row counts;
  pandas **3.1.0** verified ordering; GeoPandas **1.2.0** constructed CRS84 points
  with the original longitude/latitude values.
- The real-day benchmark exercises the same writer as the direct SQLite
  exporter. Integration tests separately exercise the SQLite path and retention.
- This measures one day per feed, not seasonal distributions or every historical
  day. It does **not** measure remote query latency, HTTP request counts, CDN
  range behavior or transfer savings for filtered queries. Production R2/CDN
  validation and the full historical migration remain deployment steps.
- Route/vehicle/time ordering is chosen for compression and trajectory access.
  It is not a claim that this order is fastest for every spatial or temporal query.

[Raw measurements, checksums and writer metadata](positions-benchmark-2026-10-27.json)
record the exact inputs and outputs. The train sample contains 2,526 `approx: 1`
rows; these remain present. None of these three inputs required the legacy Metra
seconds correction. Synthetic tests cover that correction and null coordinates.

## Reproduce locally

Use a Node release supported by the repository's native SQLite dependency
(Node 22 was used here), install dependencies with `npm ci`, and follow
[server setup](POSITIONS.md#server-setup) to install the pinned CLI and export
`POSITIONS_DUCKDB_BIN`. Download the
three historical inputs while their old endpoints remain available, or use
previously saved copies. Match their SHA-256 values to the raw measurements;
old Metra URLs were once rewritten in place and can have stale cached bytes.

```sh
mkdir -p tmp/positions-input
curl -fL https://data.chicagotransitalerts.app/positions/bus/2026/10/2026-10-27.ndjson.gz \
  -o tmp/positions-input/bus.ndjson.gz
curl -fL https://data.chicagotransitalerts.app/positions/train/2026/10/2026-10-27.ndjson.gz \
  -o tmp/positions-input/train.ndjson.gz
curl -fL https://data.chicagotransitalerts.app/positions/metra/2026/10/2026-10-27.ndjson.gz \
  -o tmp/positions-input/metra.ndjson.gz
node scripts/benchmark-positions-parquet.js --date 2026-10-27 \
  --bus tmp/positions-input/bus.ndjson.gz \
  --train tmp/positions-input/train.ndjson.gz \
  --metra tmp/positions-input/metra.ndjson.gz \
  --out tmp/positions-benchmark
```

The script invokes the production writer, checks record equality, writes the
alternative-order comparison files, and saves `results.json`. It never uploads,
changes the archive manifest or prunes SQLite. The NDJSON reader exists only
for this benchmark and the one-time migration.

## Automated checks

`npm test` covers failed uploads and remote verification, failed immutable
manifest/latest-pointer publication, retry with no new day, immutable corrections,
missing/corrupt state, refusing to drop published history, exclusive locks,
empty feeds, duplicate records, exact day bounds on both DST transitions,
source checksum/schema failures, historical cutover, retirement and dry runs.
CLI tests cover missing/wrong versions, nonzero exits, timeouts, malformed
output, disabling startup files and extension downloads, and failure before
publication or SQLite pruning. CSV round-trip cases include quotes, commas,
line breaks, NUL, Unicode, empty strings and literal null markers.
Tests use temporary SQLite/Parquet files and an in-memory object-store adapter;
they do not access production storage. `npm run smoke` verifies existing bin
imports. The repository's full suite also needs its public GTFS cache:
`npm run fetch-gtfs`. Stop-matching tests now use explicit synthetic patterns
instead of requiring an untracked local Bus Tracker cache.

Writer reference: [DuckDB CLI 2.0](https://duckdb.org/docs/2.0/clients/cli/overview).
