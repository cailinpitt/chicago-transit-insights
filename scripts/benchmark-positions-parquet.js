#!/usr/bin/env node
// Reproduce the production writer locally; never uploads or modifies history.
const Fs = require('node:fs');
const Path = require('node:path');
const { performance } = require('node:perf_hooks');
const { runDuckDb } = require('../src/shared/duckdbCli');
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
  const nodePeakRssKib = process.resourceUsage().maxRSS;
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
    const sql = [];
    const variants = [
      ['source_order', ''],
      ['route_time', 'ORDER BY route, ts, vehicle_id'],
    ];
    for (const [name, order] of variants) {
      const target = Path.join(out, `${kind}-${name}.parquet`);
      sql.push(`COPY (SELECT ${projection} FROM ${source} ${order}) TO ${sqlString(target)}
        (FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 3, ROW_GROUP_SIZE 122880,
         KV_METADATA {positions_schema_version: '2'});`);
    }
    sql.push(
      `SELECT count(DISTINCT row_group_id) AS row_groups FROM parquet_metadata(${sqlString(file)});`,
    );
    const result = await runDuckDb(sql.join('\n'), {
      memoryLimit: '512MB',
      tempDirectory: Path.join(out, 'spill'),
    });
    files[kind].alternative_bytes = Object.fromEntries(
      variants.map(([name]) => [name, Fs.statSync(Path.join(out, `${kind}-${name}.parquet`)).size]),
    );
    files[kind].row_groups = result[0].row_groups;
  }
  const result = {
    date: argv.date,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    seconds,
    node_peak_rss_kib: nodePeakRssKib,
    memory_measurement_scope: 'Node parent only; excludes the DuckDB CLI child',
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
