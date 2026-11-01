#!/usr/bin/env node
// Reproduce the production writer locally; never uploads or modifies history.
const Fs = require('node:fs');
const Path = require('node:path');
const { performance } = require('node:perf_hooks');
const { DuckDBInstance } = require('@duckdb/node-api');
const { KINDS, SCHEMA } = require('../src/shared/positionsArchive');
const { writeDay, sha256, sqlString } = require('../src/shared/positionsParquet');
const { localPath, writeJson } = require('../src/shared/positionsPublication');
const { readLegacy } = require('./migrate-positions-parquet');

async function main() {
  const argv = require('minimist')(process.argv.slice(2));
  if (!argv.date || !KINDS.every((kind) => argv[kind]))
    throw new Error(
      'Usage: node scripts/benchmark-positions-parquet.js --date YYYY-MM-DD --bus FILE --train FILE --metra FILE [--out DIR]',
    );
  const out = Path.resolve(argv.out || 'tmp/positions-benchmark');
  const inputs = {};
  for (const kind of KINDS)
    inputs[kind] = {
      bytes: Fs.statSync(argv[kind]).size,
      sha256: await sha256(argv[kind]),
    };
  async function* records() {
    for (const kind of KINDS) yield* readLegacy(argv[kind], kind, inputs[kind]);
  }
  const start = performance.now();
  const files = await writeDay(records(), argv.date, out);
  const seconds = (performance.now() - start) / 1000;
  const writerPeakRssKib = process.resourceUsage().maxRSS;
  const instance = await DuckDBInstance.create(':memory:', {
    threads: '1',
    memory_limit: '512MB',
    temp_directory: Path.join(out, 'spill'),
  });
  const connection = await instance.connect();
  try {
    for (const kind of KINDS) {
      const file = localPath(out, files[kind].path);
      const types = { integer: 'BIGINT', number: 'DOUBLE', string: 'VARCHAR' };
      const columns = Object.entries(SCHEMA[kind].fields)
        .map(([name, field]) => `${name}: ${sqlString(types[field.type])}`)
        .join(', ');
      const source = `read_json(${sqlString(argv[kind])}, format='newline_delimited', columns={${columns}})`;
      const projection =
        kind === 'metra'
          ? '* REPLACE(CASE WHEN vehicle_ts < 1e11 THEN vehicle_ts * 1000 ELSE vehicle_ts END AS vehicle_ts)'
          : '*';
      files[kind].alternative_bytes = {};
      for (const [name, order] of [
        ['source_order', ''],
        ['route_time', 'ORDER BY route, ts, vehicle_id'],
      ]) {
        const target = Path.join(out, `${kind}-${name}.parquet`);
        await connection.run(`COPY (SELECT ${projection} FROM ${source} ${order}) TO ${sqlString(target)}
          (FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 3, ROW_GROUP_SIZE 122880,
           KV_METADATA {positions_schema_version: '2'})`);
        files[kind].alternative_bytes[name] = Fs.statSync(target).size;
      }
      const result = await connection.runAndReadAll(`SELECT count(DISTINCT row_group_id)
        FROM parquet_metadata(${sqlString(file)})`);
      files[kind].row_groups = Number(result.getRows()[0][0]);
    }
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  const result = {
    date: argv.date,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    seconds,
    writer_peak_rss_kib: writerPeakRssKib,
    duckdb_memory_limit: process.env.POSITIONS_MEMORY_LIMIT || '256MB',
    inputs,
    files,
    validation: 'symmetric EXCEPT ALL: zero differences for every feed',
  };
  writeJson(Path.join(out, 'results.json'), result);
  console.log(JSON.stringify(result, null, 2));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
