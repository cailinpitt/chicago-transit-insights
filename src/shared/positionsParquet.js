// SQLite and migration rows share this writer. Bounded CSV staging passes
// explicit types to the standalone CLI; only Parquet leaves the working directory.
const Fs = require('node:fs');
const Path = require('node:path');
const Crypto = require('node:crypto');
const { DUCKDB_VERSION, checkDuckDb, runDuckDb, sqlString } = require('./duckdbCli');
const {
  KINDS,
  SCHEMA,
  SCHEMA_VERSION,
  SORT_ORDER,
  toRecord,
  dayBounds,
  filePath,
} = require('./positionsArchive');

const SQL_TYPES = { integer: 'BIGINT', number: 'DOUBLE', string: 'VARCHAR' };
const ROW_GROUP_SIZE = 122880;
const COMPRESSION_LEVEL = 3;
async function sha256(path) {
  const hash = Crypto.createHash('sha256');
  for await (const chunk of Fs.createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function validateRecord(kind, record, bounds) {
  for (const [name, field] of Object.entries(SCHEMA[kind].fields)) {
    const value = record[name];
    const valid =
      value === null
        ? field.nullable
        : field.type === 'integer'
          ? Number.isSafeInteger(value)
          : field.type === 'number'
            ? typeof value === 'number'
            : typeof value === 'string';
    if (!valid) throw new Error(`${kind}.${name}: invalid ${field.type} or nullability`);
  }
  if (record.ts < bounds.start || record.ts >= bounds.end)
    throw new Error(`${kind}: poll timestamp outside the Chicago calendar day`);
  if (
    record.sched_start_date !== undefined &&
    record.sched_start_date !== null &&
    !/^\d{4}-\d{2}-\d{2}$/.test(record.sched_start_date)
  )
    throw new Error('bus.sched_start_date must be YYYY-MM-DD');
}

// Quote all strings so empty strings and a literal \N stay distinct from NULL.
// Quotes, newlines and delimiters are data, never SQL or CLI commands.
function csvValue(value) {
  if (value === null) return '\\N';
  if (typeof value === 'string') return `"${value.replaceAll('"', '""')}"`;
  return Object.is(value, -0) ? '-0' : String(value);
}

function flush(writer) {
  if (!writer.buffer) return;
  Fs.writeFileSync(writer.fd, writer.buffer);
  writer.buffer = '';
}

async function writeDay(records, date, outDir, options = {}) {
  const bounds = dayBounds(date);
  await checkDuckDb(options);
  Fs.mkdirSync(outDir, { recursive: true });
  const scratch = Fs.mkdtempSync(Path.join(outDir, '.parquet-'));
  const writers = {};
  try {
    for (const kind of KINDS) {
      const path = Path.join(scratch, `${kind}.csv`);
      writers[kind] = { path, fd: Fs.openSync(path, 'wx'), buffer: '', rows: 0 };
    }
    for await (const row of records) {
      const kind = row.kind;
      if (!KINDS.includes(kind)) throw new Error(`Unknown observation kind: ${kind}`);
      const record = toRecord(row);
      validateRecord(kind, record, bounds);
      const writer = writers[kind];
      writer.buffer += `${Object.values(record).map(csvValue).join(',')}\n`;
      writer.rows++;
      if (writer.buffer.length >= 64 * 1024) flush(writer);
    }
    for (const writer of Object.values(writers)) {
      flush(writer);
      Fs.closeSync(writer.fd);
      writer.fd = null;
    }

    const sql = [];
    const summaries = [];
    for (const kind of KINDS) {
      const fields = Object.entries(SCHEMA[kind].fields);
      const columns = fields.map(
        ([name, field]) => `"${name}" ${SQL_TYPES[field.type]}${field.nullable ? '' : ' NOT NULL'}`,
      );
      const csvColumns = fields.map(([name, field]) => `${name}: '${SQL_TYPES[field.type]}'`);
      sql.push(`CREATE TABLE ${kind} (${columns.join(', ')});`);
      sql.push(`INSERT INTO ${kind} SELECT * FROM read_csv(${sqlString(writers[kind].path)},
        auto_detect=false, header=false, delim=',', quote='"', escape='"',
        nullstr='\\N', allow_quoted_nulls=false, parallel=false,
        columns={${csvColumns.join(', ')}});`);
      const partial = Path.join(scratch, `${kind}.parquet.partial`);
      sql.push(`COPY (SELECT * FROM ${kind} ORDER BY ${SORT_ORDER.join(', ')})
        TO ${sqlString(partial)} (FORMAT PARQUET, COMPRESSION ZSTD,
        COMPRESSION_LEVEL ${COMPRESSION_LEVEL}, ROW_GROUP_SIZE ${ROW_GROUP_SIZE},
        KV_METADATA {positions_schema_version: '${SCHEMA_VERSION}'});`);

      // A SQL error stops the CLI (-bail) before Node can promote any files.
      const readback = `read_parquet(${sqlString(partial)})`;
      sql.push(`CREATE TEMP TABLE ${kind}_validation AS SELECT
        CASE WHEN (SELECT count(*) FROM ${kind}) = ${writers[kind].rows}
          THEN true ELSE error('${kind}: staging row count mismatch') END AS input_ok,
        CASE WHEN (SELECT count(*) FROM (
          (SELECT * FROM ${kind} EXCEPT ALL SELECT * FROM ${readback}) UNION ALL
          (SELECT * FROM ${readback} EXCEPT ALL SELECT * FROM ${kind}))) = 0
          THEN true ELSE error('${kind}: Parquet round-trip mismatch') END AS records_ok,
        CASE WHEN (SELECT count(*) FROM parquet_kv_metadata(${sqlString(partial)})
          WHERE decode(key) = 'positions_schema_version' AND decode(value) = '${SCHEMA_VERSION}') = 1
          THEN true ELSE error('${kind}: Parquet schema metadata mismatch') END AS metadata_ok;`);
      summaries.push(`SELECT '${kind}' AS kind,
        count(*) AS rows, min(ts) AS ts_min, max(ts) AS ts_max,
        min(vehicle_ts) AS vehicle_ts_min, max(vehicle_ts) AS vehicle_ts_max,
        count(DISTINCT ts) AS polls,
        count(*) FILTER (WHERE lat IS NULL OR lon IS NULL OR NOT isfinite(lat) OR NOT isfinite(lon)
          OR abs(lat) > 90 OR abs(lon) > 180) AS invalid_coordinates,
        ${kind === 'train' ? 'count(*) FILTER (WHERE approx = 1)' : '0'} AS approximate FROM ${kind}`);
    }
    const stats = await runDuckDb(`${sql.join('\n')}\n${summaries.join(' UNION ALL ')};`, {
      ...options,
      database: Path.join(scratch, 'staging.duckdb'),
      tempDirectory: Path.join(scratch, 'spill'),
    });
    // Also validate the machine-readable response, not just the process status.
    if (
      stats.length !== KINDS.length ||
      !KINDS.every(
        (kind) =>
          stats.filter((row) => row.kind === kind && row.rows === writers[kind].rows).length === 1,
      )
    )
      throw new Error('DuckDB CLI returned an incomplete archive summary');

    const files = {};
    for (const kind of KINDS) {
      const row = stats.find((value) => value.kind === kind);
      const partial = Path.join(scratch, `${kind}.parquet.partial`);
      const hash = await sha256(partial);
      const relative = filePath(kind, date, hash);
      const finalPath = Path.join(outDir, relative);
      Fs.mkdirSync(Path.dirname(finalPath), { recursive: true });
      Fs.renameSync(partial, finalPath);
      files[kind] = {
        path: `positions/${relative}`,
        format: 'parquet',
        schema_version: SCHEMA_VERSION,
        data_revision: hash,
        sha256: hash,
        bytes: Fs.statSync(finalPath).size,
        rows: row.rows,
        ts_min: row.ts_min,
        ts_max: row.ts_max,
        vehicle_ts_min: row.vehicle_ts_min,
        vehicle_ts_max: row.vehicle_ts_max,
        quality: {
          distinct_polls: row.polls,
          invalid_coordinate_rows: row.invalid_coordinates,
          approx_rows: row.approximate,
        },
        writer: {
          duckdb: DUCKDB_VERSION,
          client: 'cli',
          compression: 'zstd',
          compression_level: COMPRESSION_LEVEL,
          row_group_size: ROW_GROUP_SIZE,
          sort_order: SORT_ORDER,
        },
      };
    }
    return files;
  } finally {
    for (const writer of Object.values(writers)) {
      if (writer.fd !== null) Fs.closeSync(writer.fd);
    }
    Fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function exportDay(db, date, outDir, options) {
  const { start, end } = dayBounds(date);
  const rows = db
    .prepare('SELECT * FROM observations WHERE ts >= ? AND ts < ?')
    .iterate(start, end);
  return writeDay(rows, date, outDir, options);
}

module.exports = { writeDay, exportDay, sha256, sqlString };
