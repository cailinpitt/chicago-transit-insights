#!/usr/bin/env node
// One-time legacy input reader. New daily exports never pass through NDJSON.
require('../src/shared/env');
const Fs = require('node:fs');
const Path = require('node:path');
const Zlib = require('node:zlib');
const Readline = require('node:readline');
const { pipeline } = require('node:stream/promises');
const { runBin } = require('../src/shared/runBin');
const {
  KINDS,
  SCHEMA,
  newManifest,
  indexDays,
  verifiedDay,
  metraVehicleTsMs,
} = require('../src/shared/positionsArchive');
const { writeDay } = require('../src/shared/positionsParquet');
const {
  readJson,
  writeJson,
  localPath,
  verifyLocal,
  rcloneStore,
  uploadDay,
  publishIndex,
  withLock,
} = require('../src/shared/positionsPublication');
const { MANIFEST_PATH, ARCHIVE_DIR, REMOTE } = require('../bin/export-positions');

async function* readLegacy(path, kind, ledger = {}) {
  const input = Fs.createReadStream(path);
  const gunzip = Zlib.createGunzip();
  const done = pipeline(input, gunzip);
  // Attach rejection handling immediately, including before the first line.
  done.catch(() => {});
  const lines = Readline.createInterface({ input: gunzip, crlfDelay: Infinity });
  ledger.rows = 0;
  ledger.normalized_vehicle_ts = 0;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      for (const key of Object.keys(row)) {
        if (!Object.hasOwn(SCHEMA[kind].fields, key))
          throw new Error(`${path}: unexpected field ${key}; refusing to discard it`);
      }
      if (kind === 'metra' && metraVehicleTsMs(row.vehicle_ts) !== row.vehicle_ts)
        ledger.normalized_vehicle_ts++;
      ledger.rows++;
      yield { ...row, kind, ...(kind === 'bus' && { direction: row.pid }) };
    }
    await done;
  } finally {
    lines.close();
    input.destroy();
    gunzip.destroy();
  }
}

function legacyInventory(legacy, previous) {
  const byDate = indexDays(previous);
  for (const [date, entry] of Object.entries(legacy)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Not a legacy manifest');
    if (byDate[date] && JSON.stringify(byDate[date]) !== JSON.stringify(entry.files)) {
      for (const kind of KINDS) {
        if (byDate[date][kind]?.sha256 !== entry.files?.[kind]?.sha256)
          throw new Error(`${date}/${kind}: local manifest disagrees with published history`);
      }
    }
    byDate[date] = entry.files;
  }
  for (const [date, files] of Object.entries(byDate)) {
    for (const kind of KINDS) {
      const file = files?.[kind];
      const expected = `positions/${kind}/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.ndjson.gz`;
      if (
        file?.path !== expected ||
        !/^[a-f0-9]{64}$/.test(file.sha256) ||
        !Number.isSafeInteger(file.rows) ||
        file.rows < 0 ||
        !Number.isSafeInteger(file.bytes)
      )
        throw new Error(`${date}/${kind}: invalid or missing legacy file metadata`);
    }
  }
  if (!Object.keys(byDate).length) throw new Error('No legacy archive to migrate');
  return byDate;
}

async function retireLegacy(manifest, outDir, store, save) {
  if (
    !manifest.published ||
    Object.values(manifest.days).some((d) => !d.committed || !verifiedDay(d))
  )
    throw new Error('Retirement requires a committed, verified Parquet archive');
  const pointer = await store.readJson('positions/index.json');
  if (pointer.path !== manifest.published.path || pointer.sha256 !== manifest.published.sha256)
    throw new Error('Latest index does not reference the committed Parquet manifest');
  await store.verify(manifest.published.path, manifest.published);
  for (const entry of Object.values(manifest.days)) {
    for (const kind of KINDS) {
      const source = entry.sources?.[kind];
      if (!source || source.retired_at) continue;
      // Keep the exact migration target in the ledger, even if a later
      // correction has since become the canonical revision.
      if (!source.parquet) throw new Error('Missing migration destination in source ledger');
      await store.verify(source.parquet.path, source.parquet);
      if (entry.files[kind].sha256 !== source.parquet.sha256)
        await store.verify(entry.files[kind].path, entry.files[kind]);
      const local = localPath(outDir, source.path);
      if (Fs.existsSync(local)) await verifyLocal(local, source);
      await store.remove(source.path);
      Fs.rmSync(local, { force: true });
      source.retired_at = new Date().toISOString();
      save(manifest);
    }
  }
}

async function migrate({
  manifestPath = MANIFEST_PATH,
  outDir = ARCHIVE_DIR,
  store = rcloneStore(REMOTE),
  cutover = false,
  retire = false,
  now = Date.now(),
} = {}) {
  const legacy = readJson(manifestPath);
  const save = (value) => writeJson(manifestPath, value);
  if (legacy.manifest_version === 2) {
    if (retire) await retireLegacy(legacy, outDir, store, save);
    return legacy;
  }
  if (retire) throw new Error('Run --cutover successfully before --retire-ndjson');
  const previous = await store.readJson('positions/index.json');
  // After an interrupted cutover the remote pointer may already be Parquet.
  // Keep the full legacy index, including days missing from local state.
  const indexBackup = Path.join(outDir, 'index.ndjson-backup.json');
  if (previous.manifest_version !== 2) {
    if (!Array.isArray(previous.days)) throw new Error('Legacy index has no days inventory');
    writeJson(indexBackup, previous);
  }
  const inventory = legacyInventory(legacy, readJson(indexBackup));
  const stagedPath = `${manifestPath}.parquet-migration`;
  const manifest = readJson(stagedPath, newManifest());
  const saveStaged = (value) => writeJson(stagedPath, value);
  for (const date of Object.keys(inventory).sort()) {
    let entry = manifest.days[date];
    if (entry) {
      for (const kind of KINDS) {
        if (entry.sources?.[kind]?.sha256 !== inventory[date][kind].sha256)
          throw new Error(
            `${date}: migration source changed; restore the matching source or restart staging`,
          );
      }
    }
    if (verifiedDay(entry)) continue;
    if (!entry?.files) {
      const sources = structuredClone(inventory[date]);
      for (const kind of KINDS) {
        const source = sources[kind];
        const local = localPath(outDir, source.path);
        if (!Fs.existsSync(local)) await store.download(source.path, local);
        await verifyLocal(local, source);
      }
      async function* records() {
        for (const kind of KINDS) {
          const source = sources[kind];
          const validation = {};
          yield* readLegacy(localPath(outDir, source.path), kind, validation);
          if (validation.rows !== source.rows)
            throw new Error(`${date}/${kind}: legacy row count mismatch`);
          source.validation = {
            ...validation,
            comparison: 'symmetric EXCEPT ALL after schema-v2 normalization',
          };
        }
      }
      const files = await writeDay(records(), date, outDir);
      for (const kind of KINDS) {
        const { path, sha256, bytes, rows, schema_version } = files[kind];
        sources[kind].parquet = { path, sha256, bytes, rows, schema_version };
      }
      entry = manifest.days[date] = {
        files,
        sources,
        verified: false,
        committed: false,
      };
      saveStaged(manifest);
    }
    await uploadDay(entry, outDir, store);
    saveStaged(manifest);
    console.log(`${date}: historical Parquet verified`);
  }
  if (cutover) {
    // Recheck all replacements, including days staged by an earlier process.
    for (const date of Object.keys(inventory)) {
      const entry = manifest.days[date];
      if (!verifiedDay(entry)) throw new Error(`${date}: incomplete migration`);
      for (const file of Object.values(entry.files)) await store.verify(file.path, file);
    }
    const backup = `${manifestPath}.ndjson-backup`;
    if (!Fs.existsSync(backup)) Fs.copyFileSync(manifestPath, backup, Fs.constants.COPYFILE_EXCL);
    await publishIndex(manifest, outDir, store, saveStaged, now, {
      days: Object.entries(inventory).map(([date, files]) => ({ date, files })),
    });
    save(manifest);
  }
  return manifest;
}

async function main() {
  const argv = require('minimist')(process.argv.slice(2));
  await withLock(`${MANIFEST_PATH}.lock`, () =>
    migrate({
      cutover: !!argv.cutover,
      retire: !!argv['retire-ndjson'],
    }),
  );
}
if (require.main === module) runBin(main);
module.exports = { readLegacy, legacyInventory, migrate, retireLegacy };
