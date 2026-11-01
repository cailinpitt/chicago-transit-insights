// The production writer consumes SQLite rows directly. The migration feeds the
// same writer a stream of legacy records; neither path buffers a day's JSON.
const Fs = require('node:fs');
const Path = require('node:path');
const Crypto = require('node:crypto');
const { DuckDBInstance, version } = require('@duckdb/node-api');
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
// SQL values only. Identifiers below come exclusively from the fixed schema.
const sqlString = (value) => `'${String(value).replaceAll("'", "''")}'`;

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

async function scalar(connection, sql) {
  const result = await connection.runAndReadAll(sql);
  return result.getRows()[0][0];
}

async function writeDay(records, date, outDir, options = {}) {
  const bounds = dayBounds(date);
  Fs.mkdirSync(outDir, { recursive: true });
  const scratch = Fs.mkdtempSync(Path.join(outDir, '.parquet-'));
  let instance;
  let connection;
  const appenders = {};
  try {
    instance = await DuckDBInstance.create(Path.join(scratch, 'staging.duckdb'), {
      threads: '1',
      memory_limit: options.memoryLimit || process.env.POSITIONS_MEMORY_LIMIT || '256MB',
      temp_directory: Path.join(scratch, 'spill'),
    });
    connection = await instance.connect();
    for (const kind of KINDS) {
      const columns = Object.entries(SCHEMA[kind].fields).map(
        ([name, field]) => `"${name}" ${SQL_TYPES[field.type]}${field.nullable ? '' : ' NOT NULL'}`,
      );
      await connection.run(`CREATE TABLE ${kind} (${columns.join(', ')})`);
      appenders[kind] = await connection.createAppender(kind);
    }
    for await (const row of records) {
      const kind = row.kind;
      if (!KINDS.includes(kind)) throw new Error(`Unknown observation kind: ${kind}`);
      const record = toRecord(row);
      validateRecord(kind, record, bounds);
      const appender = appenders[kind];
      for (const [name, field] of Object.entries(SCHEMA[kind].fields)) {
        const value = record[name];
        if (value === null) appender.appendNull();
        else if (field.type === 'integer') appender.appendBigInt(BigInt(value));
        else if (field.type === 'number') appender.appendDouble(value);
        else appender.appendVarchar(value);
      }
      appender.endRow();
    }
    for (const [kind, appender] of Object.entries(appenders)) {
      appender.closeSync();
      delete appenders[kind];
    }

    const files = {};
    for (const kind of KINDS) {
      const statsReader = await connection.runAndReadAll(`SELECT
        count(*) AS rows, min(ts) AS ts_min, max(ts) AS ts_max,
        min(vehicle_ts) AS vehicle_ts_min, max(vehicle_ts) AS vehicle_ts_max,
        count(DISTINCT ts) AS polls, count(*) FILTER (WHERE lat IS NULL OR lon IS NULL OR NOT isfinite(lat) OR NOT isfinite(lon)
          OR abs(lat) > 90 OR abs(lon) > 180) AS invalid_coordinates,
        ${kind === 'train' ? 'count(*) FILTER (WHERE approx = 1)' : '0'} AS approximate FROM ${kind}`);
      const stats = statsReader.getRows()[0].map((v) => (typeof v === 'bigint' ? Number(v) : v));
      const [
        rows,
        tsMin,
        tsMax,
        vehicleTsMin,
        vehicleTsMax,
        polls,
        invalidCoordinates,
        approximate,
      ] = stats;
      const partial = Path.join(scratch, `${kind}.parquet.partial`);
      await connection.run(`COPY (SELECT * FROM ${kind} ORDER BY ${SORT_ORDER.join(', ')})
        TO ${sqlString(partial)} (FORMAT PARQUET, COMPRESSION ZSTD,
        COMPRESSION_LEVEL ${COMPRESSION_LEVEL}, ROW_GROUP_SIZE ${ROW_GROUP_SIZE},
        KV_METADATA {positions_schema_version: '${SCHEMA_VERSION}'})`);

      // Multiset comparison includes every column and duplicate multiplicity.
      const readback = `read_parquet(${sqlString(partial)})`;
      const differences = await scalar(
        connection,
        `SELECT count(*) FROM (
        (SELECT * FROM ${kind} EXCEPT ALL SELECT * FROM ${readback}) UNION ALL
        (SELECT * FROM ${readback} EXCEPT ALL SELECT * FROM ${kind}))`,
      );
      if (differences !== 0n) throw new Error(`${date}/${kind}: Parquet round-trip mismatch`);
      const metadata = await scalar(
        connection,
        `SELECT decode(value) FROM
        parquet_kv_metadata(${sqlString(partial)}) WHERE decode(key) = 'positions_schema_version'`,
      );
      if (metadata !== String(SCHEMA_VERSION)) throw new Error('Parquet schema metadata mismatch');

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
        rows,
        ts_min: tsMin,
        ts_max: tsMax,
        vehicle_ts_min: vehicleTsMin,
        vehicle_ts_max: vehicleTsMax,
        quality: {
          distinct_polls: polls,
          invalid_coordinate_rows: invalidCoordinates,
          approx_rows: approximate,
        },
        writer: {
          duckdb: version(),
          compression: 'zstd',
          compression_level: COMPRESSION_LEVEL,
          row_group_size: ROW_GROUP_SIZE,
          sort_order: SORT_ORDER,
        },
      };
    }
    return files;
  } finally {
    for (const appender of Object.values(appenders)) {
      appender.clear();
      appender.closeSync();
    }
    connection?.closeSync();
    instance?.closeSync();
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
