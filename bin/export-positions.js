#!/usr/bin/env node
// Archive each finished Chicago day of vehicle positions to gzipped NDJSON,
// keep it on the server, publish it to the public data bucket under
// positions/, then trim the observations table back to its hot window.
//
// Rows are only deleted for days that are archived locally AND uploaded, so a
// failed upload just leaves them in the DB for the next run. --dry-run writes
// files to tmp/positions-dry-run and uploads/deletes nothing. See
// docs/POSITIONS.md.
require('../src/shared/env');

const Fs = require('node:fs');
const Path = require('node:path');
const Zlib = require('node:zlib');
const Crypto = require('node:crypto');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const argv = require('minimist')(process.argv.slice(2));

const { runBin } = require('../src/shared/runBin');
const {
  KINDS,
  toRecord,
  dayBounds,
  completedDays,
  filePath,
  rolloffCutoff,
  buildIndex,
} = require('../src/shared/positionsArchive');

const REPO = Path.join(__dirname, '..');
const DB_PATH = process.env.HISTORY_DB_PATH || Path.join(REPO, 'state', 'history.sqlite');
const MANIFEST_PATH =
  process.env.POSITIONS_MANIFEST_PATH || Path.join(REPO, 'state', 'positions-manifest.json');
const ARCHIVE_DIR = process.env.POSITIONS_ARCHIVE_DIR || Path.join(REPO, 'archive', 'positions');
const REMOTE = process.env.RCLONE_REMOTE || 'r2web:cta-alert-history-data';
const DELETE_BATCH_MS = 60 * 60 * 1000;

function loadManifest() {
  try {
    return JSON.parse(Fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

function saveManifest(manifest) {
  const tmp = `${MANIFEST_PATH}.tmp`;
  Fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  Fs.renameSync(tmp, MANIFEST_PATH);
}

function sha256(path) {
  return Crypto.createHash('sha256').update(Fs.readFileSync(path)).digest('hex');
}

// One ts-ordered pass over the day, fanned out to a gzip stream per kind.
// Written to .partial and renamed so a crash never leaves a truncated file
// under the final name.
async function exportDay(db, date, outDir) {
  const { start, end } = dayBounds(date);
  const writers = {};
  for (const kind of KINDS) {
    const finalPath = Path.join(outDir, filePath(kind, date));
    Fs.mkdirSync(Path.dirname(finalPath), { recursive: true });
    const gzip = Zlib.createGzip({ level: 9 });
    const file = Fs.createWriteStream(`${finalPath}.partial`);
    gzip.pipe(file);
    writers[kind] = { finalPath, gzip, file, rows: 0 };
  }

  const rows = db
    .prepare('SELECT * FROM observations WHERE ts >= ? AND ts < ? ORDER BY ts')
    .iterate(start, end);
  for (const row of rows) {
    const w = writers[row.kind];
    if (!w) continue;
    w.rows++;
    if (!w.gzip.write(`${JSON.stringify(toRecord(row))}\n`)) await once(w.gzip, 'drain');
  }

  const files = {};
  for (const kind of KINDS) {
    const w = writers[kind];
    w.gzip.end();
    await once(w.file, 'finish');
    Fs.renameSync(`${w.finalPath}.partial`, w.finalPath);
    files[kind] = {
      path: `positions/${filePath(kind, date)}`,
      rows: w.rows,
      bytes: Fs.statSync(w.finalPath).size,
      sha256: sha256(w.finalPath),
    };
  }
  return files;
}

// Served as a plain .gz download (no Content-Encoding) so clients save the
// compressed file as-is. Finished days never change, so cache them hard.
function upload(localPath, remotePath, contentType, maxAge) {
  execFileSync(
    'rclone',
    [
      'copyto',
      localPath,
      `${REMOTE}/${remotePath}`,
      '--s3-no-check-bucket',
      '--header-upload',
      `Content-Type: ${contentType}`,
      '--header-upload',
      `Cache-Control: public, max-age=${maxAge}`,
    ],
    { stdio: 'pipe' },
  );
}

function deleteBefore(db, cutoff) {
  const oldest = db.prepare('SELECT MIN(ts) AS ts FROM observations').get().ts;
  if (oldest == null || oldest >= cutoff) return 0;
  const del = db.prepare('DELETE FROM observations WHERE ts >= ? AND ts < ?');
  let deleted = 0;
  for (let from = oldest; from < cutoff; from += DELETE_BATCH_MS) {
    deleted += del.run(from, Math.min(from + DELETE_BATCH_MS, cutoff)).changes;
  }
  return deleted;
}

async function main() {
  const dryRun = !!argv['dry-run'];
  const now = Date.now();
  const manifest = loadManifest();
  const outDir = dryRun ? Path.join(REPO, 'tmp', 'positions-dry-run') : ARCHIVE_DIR;
  const readDb = new Database(DB_PATH, { readonly: true });

  let days = completedDays(now).filter((d) => !manifest[d]?.uploaded);
  if (argv.limit) days = days.slice(0, Number(argv.limit));

  for (const date of days) {
    const t0 = Date.now();
    const files = manifest[date]?.files || (await exportDay(readDb, date, outDir));
    const summary = KINDS.map((k) => `${k}=${files[k].rows}`).join(' ');
    console.log(`${date}: ${summary} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    if (dryRun) continue;

    manifest[date] = { files, uploaded: false };
    saveManifest(manifest);
    for (const kind of KINDS) {
      upload(Path.join(outDir, filePath(kind, date)), files[kind].path, 'application/gzip', 86400);
    }
    manifest[date].uploaded = true;
    saveManifest(manifest);
  }
  readDb.close();

  const cutoff = rolloffCutoff(manifest, now);
  if (dryRun) {
    console.log(`dry run: would delete observations before ${new Date(cutoff).toISOString()}`);
    return;
  }

  if (days.length > 0 || argv['publish-index']) {
    Fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    const indexPath = Path.join(ARCHIVE_DIR, 'index.json');
    Fs.writeFileSync(indexPath, `${JSON.stringify(buildIndex(manifest, now), null, 2)}\n`);
    upload(indexPath, 'positions/index.json', 'application/json', 300);
  }

  const db = new Database(DB_PATH);
  db.pragma(`busy_timeout = ${Number(process.env.SQLITE_BUSY_TIMEOUT_MS) || 30000}`);
  const deleted = deleteBefore(db, cutoff);
  db.close();
  console.log(`rolloff: deleted ${deleted} rows before ${new Date(cutoff).toISOString()}`);
}

if (require.main === module) runBin(main);

module.exports = { ARCHIVE_DIR, loadManifest, saveManifest, sha256, upload };
