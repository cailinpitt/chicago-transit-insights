#!/usr/bin/env node
// One-off (2026-11-01): Metra vehicle_ts was stored in epoch seconds instead of
// ms. Converts the rows still in observations, rewrites the archived Metra
// files, updates their manifest entries, re-uploads them and the index.
// Idempotent: values already in ms are left alone. --dry-run reports counts only.
require('../src/shared/env');

const Fs = require('node:fs');
const Path = require('node:path');
const Zlib = require('node:zlib');
const Database = require('better-sqlite3');
const argv = require('minimist')(process.argv.slice(2));

const { runBin } = require('../src/shared/runBin');
const {
  MAX_SECONDS_TS,
  metraVehicleTsMs,
  filePath,
  buildIndex,
} = require('../src/shared/positionsArchive');
const {
  ARCHIVE_DIR,
  loadManifest,
  saveManifest,
  sha256,
  upload,
} = require('../bin/export-positions');

const DB_PATH =
  process.env.HISTORY_DB_PATH || Path.join(__dirname, '..', 'state', 'history.sqlite');
const BATCH_MS = 60 * 60 * 1000;

function fixDb(dryRun) {
  const db = new Database(DB_PATH, { readonly: dryRun });
  db.pragma(`busy_timeout = ${Number(process.env.SQLITE_BUSY_TIMEOUT_MS) || 30000}`);
  const where = `kind = 'metra' AND vehicle_ts < ${MAX_SECONDS_TS}`;
  if (dryRun) {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM observations WHERE ${where}`).get().n;
    db.close();
    return n;
  }
  const { lo, hi } = db
    .prepare(`SELECT MIN(ts) AS lo, MAX(ts) AS hi FROM observations WHERE ${where}`)
    .get();
  let updated = 0;
  if (lo != null) {
    const stmt = db.prepare(
      `UPDATE observations SET vehicle_ts = vehicle_ts * 1000 WHERE ts >= ? AND ts < ? AND ${where}`,
    );
    for (let from = lo; from <= hi; from += BATCH_MS) {
      updated += stmt.run(from, from + BATCH_MS).changes;
    }
  }
  db.close();
  return updated;
}

function rewriteFile(path) {
  let changed = 0;
  const lines = Zlib.gunzipSync(Fs.readFileSync(path)).toString('utf8').split('\n');
  const out = lines.map((line) => {
    if (!line) return line;
    const rec = JSON.parse(line);
    const fixed = metraVehicleTsMs(rec.vehicle_ts);
    if (fixed === rec.vehicle_ts) return line;
    changed++;
    rec.vehicle_ts = fixed;
    return JSON.stringify(rec);
  });
  return { changed, rows: lines.filter(Boolean).length, body: out.join('\n') };
}

async function main() {
  const dryRun = !!argv['dry-run'];
  console.log(`observations: ${dryRun ? 'would update' : 'updated'} ${fixDb(dryRun)} Metra rows`);

  const manifest = loadManifest();
  let rewritten = 0;
  for (const date of Object.keys(manifest).sort()) {
    const entry = manifest[date].files?.metra;
    if (!entry) continue;
    const local = Path.join(ARCHIVE_DIR, filePath('metra', date));
    const { changed, rows, body } = rewriteFile(local);
    if (rows !== entry.rows)
      throw new Error(`${date}: ${rows} rows on disk, manifest says ${entry.rows}`);
    if (changed === 0) continue;
    console.log(`${date}: ${changed}/${rows} rows to fix`);
    if (dryRun) continue;

    Fs.writeFileSync(`${local}.partial`, Zlib.gzipSync(body, { level: 9 }));
    Fs.renameSync(`${local}.partial`, local);
    entry.bytes = Fs.statSync(local).size;
    entry.sha256 = sha256(local);
    manifest[date].uploaded = false;
    saveManifest(manifest);
    upload(local, entry.path, 'application/gzip', 86400);
    manifest[date].uploaded = true;
    saveManifest(manifest);
    rewritten++;
  }

  if (dryRun || rewritten === 0) {
    console.log(`files: ${dryRun ? 'dry run' : 'nothing to rewrite'}`);
    return;
  }
  const indexPath = Path.join(ARCHIVE_DIR, 'index.json');
  Fs.writeFileSync(indexPath, `${JSON.stringify(buildIndex(manifest), null, 2)}\n`);
  upload(indexPath, 'positions/index.json', 'application/json', 300);
  console.log(`files: rewrote and uploaded ${rewritten}, republished index.json`);
}

runBin(main);
