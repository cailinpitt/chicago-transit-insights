#!/usr/bin/env node
// Direct SQLite -> sorted Parquet -> verified object -> committed manifest.
// Only committed days permit observations to leave the 14-day hot window.
require('../src/shared/env');
const Path = require('node:path');
const Database = require('better-sqlite3');
const { runBin } = require('../src/shared/runBin');
const {
  completedDays,
  rolloffCutoff,
  verifiedDay,
  chicagoDate,
  addDays,
  HOT_WINDOW_DAYS,
} = require('../src/shared/positionsArchive');
const { exportDay } = require('../src/shared/positionsParquet');
const {
  readJson,
  verifyLocal,
  writeJson,
  loadManifest,
  localPath,
  rcloneStore,
  uploadDay,
  publishIndex,
  withLock,
} = require('../src/shared/positionsPublication');

const REPO = Path.join(__dirname, '..');
const DB_PATH = process.env.HISTORY_DB_PATH || Path.join(REPO, 'state', 'history.sqlite');
const MANIFEST_PATH =
  process.env.POSITIONS_MANIFEST_PATH || Path.join(REPO, 'state', 'positions-manifest.json');
const ARCHIVE_DIR = process.env.POSITIONS_ARCHIVE_DIR || Path.join(REPO, 'archive', 'positions');
const REMOTE = process.env.RCLONE_REMOTE || 'r2web:cta-alert-history-data';
const DELETE_BATCH_MS = 60 * 60 * 1000;

function deleteBefore(db, cutoff) {
  const oldest = db.prepare('SELECT MIN(ts) AS ts FROM observations').get().ts;
  if (oldest == null || oldest >= cutoff) return 0;
  const del = db.prepare('DELETE FROM observations WHERE ts >= ? AND ts < ?');
  let deleted = 0;
  for (let from = oldest; from < cutoff; from += DELETE_BATCH_MS)
    deleted += del.run(from, Math.min(from + DELETE_BATCH_MS, cutoff)).changes;
  return deleted;
}

async function runExport({
  dbPath = DB_PATH,
  manifestPath = MANIFEST_PATH,
  outDir = ARCHIVE_DIR,
  archiveDir = outDir,
  store = rcloneStore(REMOTE),
  now = Date.now(),
  startDate,
  dryRun = false,
  limit,
  republish = false,
  reexportDate,
} = {}) {
  const manifest = loadManifest(manifestPath);
  if (manifest.published)
    await verifyLocal(localPath(archiveDir, manifest.published.path), manifest.published);
  const previous = manifest.published
    ? readJson(localPath(archiveDir, manifest.published.path))
    : null;
  for (const day of previous?.days || []) {
    const entry = manifest.days[day.date];
    if (
      !entry ||
      (entry.committed &&
        Object.entries(day.files).some(
          ([kind, file]) => entry.files?.[kind]?.sha256 !== file.sha256,
        ))
    )
      throw new Error(`Published day ${day.date} disagrees with local state; restore the manifest`);
  }
  // A missing local manifest must never recreate pruned history as empty days.
  const existingIndex = readJson(Path.join(archiveDir, 'index.json'), null);
  if (
    !manifest.published &&
    existingIndex &&
    (existingIndex.manifest_version !== 2 || !Object.keys(manifest.days).length)
  )
    throw new Error(
      'Existing archive index without a committed Parquet manifest: migrate or restore state',
    );
  const save = (value) => writeJson(manifestPath, value);
  const readDb = new Database(dbPath, { readonly: true });
  try {
    const completed = completedDays(now, startDate);
    if (
      reexportDate &&
      (!completed.includes(reexportDate) ||
        reexportDate < addDays(chicagoDate(now), -HOT_WINDOW_DAYS))
    )
      throw new Error(
        '--reexport-date must be a completed day inside the retained SQLite hot window',
      );
    let days = reexportDate
      ? [reexportDate]
      : completed.filter((d) => !verifiedDay(manifest.days[d]));
    if (limit !== undefined) {
      if (!Number.isSafeInteger(limit) || limit < 1)
        throw new Error('--limit must be a positive integer');
      days = days.slice(0, limit);
    }
    for (const date of days) {
      const oldEntry = manifest.days[date];
      const files =
        (!dryRun && !reexportDate && oldEntry?.files) || (await exportDay(readDb, date, outDir));
      if (reexportDate && oldEntry) {
        for (const [kind, file] of Object.entries(files)) {
          const previousFile = previous?.days.find((day) => day.date === date)?.files[kind];
          if (previousFile && file.sha256 !== previousFile.sha256)
            file.replaces = { path: previousFile.path, sha256: previousFile.sha256 };
        }
      }
      console.log(
        `${date}: ${Object.entries(files)
          .map(([k, f]) => `${k}=${f.rows}`)
          .join(' ')}`,
      );
      if (dryRun) continue;
      const entry = {
        files,
        verified: false,
        committed: false,
        ...(oldEntry?.sources && { sources: oldEntry.sources }),
      };
      manifest.days[date] = entry;
      save(manifest);
      await uploadDay(entry, outDir, store);
      save(manifest);
    }
  } finally {
    readDb.close();
  }
  if (dryRun) return manifest;
  if (republish || Object.values(manifest.days).some((d) => !d.committed))
    await publishIndex(manifest, outDir, store, save, now, previous);
  const cutoff = rolloffCutoff(manifest, now, startDate);
  const db = new Database(dbPath);
  try {
    db.pragma(`busy_timeout = ${Number(process.env.SQLITE_BUSY_TIMEOUT_MS) || 30000}`);
    console.log(
      `rolloff: deleted ${deleteBefore(db, cutoff)} rows before ${new Date(cutoff).toISOString()}`,
    );
  } finally {
    db.close();
  }
  return manifest;
}

async function main() {
  const argv = require('minimist')(process.argv.slice(2));
  const dryRun = !!argv['dry-run'];
  const outDir = dryRun ? Path.join(REPO, 'tmp', 'positions-dry-run') : ARCHIVE_DIR;
  await withLock(`${MANIFEST_PATH}.lock`, () =>
    runExport({
      dryRun,
      outDir,
      archiveDir: ARCHIVE_DIR,
      limit: argv.limit === undefined ? undefined : Number(argv.limit),
      republish: !!argv['publish-index'],
      reexportDate: argv['reexport-date'],
    }),
  );
}

if (require.main === module) runBin(main);
module.exports = { runExport, deleteBefore, DB_PATH, MANIFEST_PATH, ARCHIVE_DIR, REMOTE };
