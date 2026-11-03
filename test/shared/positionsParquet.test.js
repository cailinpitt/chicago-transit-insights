const test = require('node:test');
const assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const Zlib = require('node:zlib');
const Crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { DuckDBInstance } = require('@duckdb/node-api');
const {
  KINDS,
  SCHEMA,
  newManifest,
  toRecord,
  dayBounds,
} = require('../../src/shared/positionsArchive');
const { writeDay, exportDay, sqlString, sha256 } = require('../../src/shared/positionsParquet');
const {
  readJson,
  writeJson,
  loadManifest,
  localPath,
  withLock,
} = require('../../src/shared/positionsPublication');
const { runExport } = require('../../bin/export-positions');
const { migrate, readLegacy } = require('../../scripts/migrate-positions-parquet');

const DATE = '2026-10-27';
const START = dayBounds(DATE).start;
const hash = (bytes) => Crypto.createHash('sha256').update(bytes).digest('hex');

function setup(t) {
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'positions-test-'));
  t.after(() => Fs.rmSync(root, { recursive: true, force: true }));
  const outDir = Path.join(root, 'archive');
  const manifestPath = Path.join(root, 'manifest.json');
  const dbPath = Path.join(root, 'history.sqlite');
  Fs.mkdirSync(outDir);
  return { root, outDir, manifestPath, dbPath };
}

function fixtureRows(date = DATE) {
  const ts = dayBounds(date).start + 1000;
  const bus = {
    kind: 'bus',
    ts,
    route: '003',
    direction: '0001',
    vehicle_id: '0009',
    destination: 'Michigan / Chicago',
    lat: 41.89179383947494,
    lon: -87.62409210205078,
    vehicle_ts: ts - 900,
    sched_start_date: '2026-10-26',
    sched_start_sec: 90000,
    pdist: 17.25,
  };
  return [
    { ...bus, route: '9', vehicle_id: '1' },
    { ...bus, ts: ts + 1000 },
    bus,
    { ...bus },
    { ...bus, vehicle_id: '0002', lat: 91 },
    { kind: 'train', ts, route: 'y', vehicle_id: '0001', approx: 1, lat: 42, lon: -87.7 },
    { kind: 'train', ts, route: 'red', vehicle_id: '0001', approx: 0 },
    { kind: 'metra', ts, route: 'ME', vehicle_id: '0001', trip_id: '0001', vehicle_ts: 1793077182 },
  ];
}

function makeDb(dbPath, rows) {
  const fields = new Set([
    'kind',
    'direction',
    ...KINDS.flatMap((k) => Object.keys(SCHEMA[k].fields)),
  ]);
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE observations (${[...fields].map((f) => `"${f}"`).join(', ')})`);
  for (const row of rows) {
    const keys = Object.keys(row);
    db.prepare(
      `INSERT INTO observations (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    ).run(...Object.values(row));
  }
  db.close();
}

function rowCount(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT count(*) AS n FROM observations').get().n;
  } finally {
    db.close();
  }
}

function fakeStore() {
  const objects = new Map();
  const calls = [];
  const store = {
    objects,
    calls,
    fail: () => false,
    check(op, path) {
      calls.push([op, path]);
      if (store.fail(op, path)) throw new Error(`injected ${op} failure: ${path}`);
    },
    async upload(local, path) {
      store.check('upload', path);
      objects.set(path, Fs.readFileSync(local));
    },
    async verify(path, file) {
      store.check('verify', path);
      const bytes = objects.get(path);
      assert.ok(bytes, `missing remote ${path}`);
      assert.equal(bytes.length, file.bytes);
      assert.equal(hash(bytes), file.sha256);
    },
    async readJson(path) {
      store.check('read', path);
      return JSON.parse(objects.get(path));
    },
    async download(path, local) {
      store.check('download', path);
      Fs.mkdirSync(Path.dirname(local), { recursive: true });
      Fs.writeFileSync(local, objects.get(path));
    },
    async remove(path) {
      store.check('remove', path);
      objects.delete(path);
    },
  };
  return store;
}

async function query(sql) {
  const instance = await DuckDBInstance.create(':memory:', { threads: '1' });
  const connection = await instance.connect();
  try {
    return (await connection.runAndReadAll(sql)).getRows();
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

test('direct SQLite export preserves typed records, duplicates, quality flags and physical sort order', async (t) => {
  const { outDir, dbPath } = setup(t);
  const rows = fixtureRows();
  makeDb(dbPath, [...rows, { ...rows[0], ts: START - 1 }, { ...rows[0], ts: dayBounds(DATE).end }]);
  const db = new Database(dbPath, { readonly: true });
  let files;
  try {
    files = await exportDay(db, DATE, outDir);
  } finally {
    db.close();
  }
  for (const kind of KINDS) {
    const file = files[kind];
    const local = localPath(outDir, file.path);
    assert.equal(await sha256(local), file.sha256);
    assert.equal(file.data_revision, file.sha256);
    const names = Object.keys(SCHEMA[kind].fields);
    const records = rows
      .filter((r) => r.kind === kind)
      .map(toRecord)
      .sort((a, b) =>
        a.route < b.route
          ? -1
          : a.route > b.route
            ? 1
            : a.vehicle_id < b.vehicle_id
              ? -1
              : a.vehicle_id > b.vehicle_id
                ? 1
                : a.ts - b.ts,
      );
    const actual = await query(
      `SELECT ${names.join(', ')} FROM read_parquet(${sqlString(local)}, file_row_number=true) ORDER BY file_row_number`,
    );
    assert.deepEqual(
      actual.map((row) => row.map((v) => (typeof v === 'bigint' ? Number(v) : v))),
      records.map((r) => names.map((name) => r[name])),
    );
    const metadata = await query(
      `SELECT decode(value) FROM parquet_kv_metadata(${sqlString(local)}) WHERE decode(key)='positions_schema_version'`,
    );
    assert.equal(metadata[0][0], '2');
    const codecs = await query(
      `SELECT DISTINCT compression FROM parquet_metadata(${sqlString(local)})`,
    );
    assert.deepEqual(codecs, [['ZSTD']]);
  }
  assert.equal(files.bus.rows, 5);
  assert.equal(files.bus.quality.invalid_coordinate_rows, 1);
  assert.equal(files.train.quality.approx_rows, 1);
  assert.equal(files.metra.vehicle_ts_min, 1793077182000);
});

test('empty files keep the complete feed schema', async (t) => {
  const { outDir } = setup(t);
  const files = await writeDay([], DATE, outDir);
  for (const kind of KINDS) {
    assert.equal(files[kind].rows, 0);
    assert.equal(files[kind].ts_min, null);
    const columns = await query(
      `DESCRIBE SELECT * FROM read_parquet(${sqlString(localPath(outDir, files[kind].path))})`,
    );
    assert.deepEqual(
      columns.map((r) => r[0]),
      Object.keys(SCHEMA[kind].fields),
    );
  }
});

test('invalid coordinates remain unchanged and are counted in quality metadata', async (t) => {
  const { outDir } = setup(t);
  const coordinates = [
    [null, 1],
    [1, null],
    [91, 0],
    [0, 181],
    [NaN, 0],
    [0, Infinity],
    [0, 0],
  ];
  const files = await writeDay(
    coordinates.map(([lat, lon], i) => ({ ...fixtureRows()[0], vehicle_id: String(i), lat, lon })),
    DATE,
    outDir,
  );
  assert.equal(files.bus.quality.invalid_coordinate_rows, 6);
  const values = await query(
    `SELECT lat, lon FROM read_parquet(${sqlString(localPath(outDir, files.bus.path))}) ORDER BY vehicle_id`,
  );
  assert.deepEqual(values, coordinates);
});

for (const date of ['2026-03-08', '2026-11-01']) {
  test(`writer respects both midnight boundaries on DST day ${date}`, async (t) => {
    const { outDir } = setup(t);
    const { start, end } = dayBounds(date);
    const base = fixtureRows(date)[0];
    const files = await writeDay(
      [
        { ...base, ts: start },
        { ...base, ts: end - 1 },
      ],
      date,
      outDir,
    );
    assert.equal(files.bus.rows, 2);
    await assert.rejects(writeDay([{ ...base, ts: end }], date, outDir), /outside/);
    await assert.rejects(writeDay([{ ...base, ts: start - 1 }], date, outDir), /outside/);
  });
}

test('invalid schema input fails without final objects or leaked staging files', async (t) => {
  const { outDir } = setup(t);
  await assert.rejects(
    writeDay([{ ...fixtureRows()[0], vehicle_id: 123 }], DATE, outDir),
    /vehicle_id/,
  );
  assert.deepEqual(Fs.readdirSync(outDir), []);
});

for (const failure of [
  'upload-data',
  'verify-data',
  'upload-manifest',
  'upload-pointer',
  'verify-pointer',
]) {
  test(`${failure} leaves observations available and retries publication with no new days`, async (t) => {
    const paths = setup(t);
    makeDb(paths.dbPath, fixtureRows());
    writeJson(paths.manifestPath, newManifest());
    const store = fakeStore();
    store.fail = (op, path) =>
      failure === 'upload-data'
        ? op === 'upload' && path.endsWith('.parquet')
        : failure === 'verify-data'
          ? op === 'verify' && path.endsWith('.parquet')
          : failure === 'upload-manifest'
            ? op === 'upload' && path.includes('/manifests/')
            : failure === 'upload-pointer'
              ? op === 'upload' && path === 'positions/index.json'
              : op === 'verify' && path === 'positions/index.json';
    const args = { ...paths, store, now: dayBounds('2026-10-28').start, startDate: DATE };
    await assert.rejects(runExport(args), /injected/);
    assert.equal(rowCount(paths.dbPath), fixtureRows().length);
    assert.equal(readJson(paths.manifestPath).days[DATE].committed, false);
    store.fail = () => false;
    const manifest = await runExport(args);
    assert.equal(manifest.days[DATE].committed, true);
    const pointer = await store.readJson('positions/index.json');
    await store.verify(pointer.path, pointer);
    const index = await store.readJson(pointer.path);
    assert.equal(index.days.length, 1);
    const lastUpload = store.calls.filter(([op]) => op === 'upload').at(-1);
    assert.deepEqual(lastUpload, ['upload', 'positions/index.json']);
  });
}

test('old observations roll off only after a successful manifest commit', async (t) => {
  const paths = setup(t);
  makeDb(paths.dbPath, fixtureRows());
  writeJson(paths.manifestPath, newManifest());
  const store = fakeStore();
  store.fail = (op, path) => op === 'upload' && path === 'positions/index.json';
  const args = { ...paths, store, now: dayBounds('2026-11-11').start, startDate: DATE, limit: 1 };
  await assert.rejects(runExport(args));
  assert.equal(rowCount(paths.dbPath), fixtureRows().length);
  store.fail = () => false;
  await runExport(args);
  assert.equal(rowCount(paths.dbPath), 0);
});

test('dry run changes neither state nor SQLite and makes no remote calls', async (t) => {
  const paths = setup(t);
  makeDb(paths.dbPath, fixtureRows());
  writeJson(paths.manifestPath, newManifest());
  const before = Fs.readFileSync(paths.manifestPath, 'utf8');
  const store = fakeStore();
  await runExport({
    ...paths,
    store,
    now: dayBounds('2026-10-28').start,
    startDate: DATE,
    dryRun: true,
  });
  assert.deepEqual(store.calls, []);
  assert.equal(Fs.readFileSync(paths.manifestPath, 'utf8'), before);
  assert.equal(rowCount(paths.dbPath), fixtureRows().length);
});

test('missing, corrupt or legacy state is never treated as a fresh archive', (t) => {
  const { manifestPath } = setup(t);
  assert.throws(() => loadManifest(manifestPath), /ENOENT/);
  Fs.writeFileSync(manifestPath, '{');
  assert.throws(() => loadManifest(manifestPath), SyntaxError);
  writeJson(manifestPath, { [DATE]: { uploaded: true } });
  assert.throws(() => loadManifest(manifestPath), /migrate-positions/);
});

test('a second exporter or migration cannot acquire the same lock', async (t) => {
  const { root } = setup(t);
  const path = Path.join(root, 'archive.lock');
  await withLock(path, async () =>
    assert.rejects(
      withLock(path, async () => {}),
      /EEXIST/,
    ),
  );
  assert.equal(Fs.existsSync(path), false);
});

async function legacyFixture(paths, store) {
  const files = {};
  for (const kind of KINDS) {
    const records = fixtureRows()
      .filter((r) => r.kind === kind)
      .map(toRecord);
    // Exercise the explicitly versioned legacy seconds normalization.
    if (kind === 'metra') records[0].vehicle_ts = 1793077182;
    const bytes = Zlib.gzipSync(records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const path = `positions/${kind}/2026/10/${DATE}.ndjson.gz`;
    files[kind] = { path, rows: records.length, bytes: bytes.length, sha256: hash(bytes) };
    store.objects.set(path, bytes);
  }
  writeJson(paths.manifestPath, { [DATE]: { uploaded: true, files } });
  store.objects.set(
    'positions/index.json',
    Buffer.from(JSON.stringify({ days: [{ date: DATE, files }] })),
  );
  return files;
}

test('migration stages all modes, validates sources, cuts over atomically and retires legacy data', async (t) => {
  const paths = setup(t);
  const store = fakeStore();
  const old = await legacyFixture(paths, store);
  const manifest = await migrate({ ...paths, store });
  assert.equal(readJson(paths.manifestPath).manifest_version, undefined);
  assert.equal((await store.readJson('positions/index.json')).manifest_version, undefined);
  assert.equal(manifest.days[DATE].sources.metra.validation.normalized_vehicle_ts, 1);
  await assert.rejects(migrate({ ...paths, store, retire: true }), /cutover/);
  store.fail = (op, path) => op === 'verify' && path === 'positions/index.json';
  await assert.rejects(migrate({ ...paths, store, cutover: true }), /injected/);
  assert.equal(readJson(paths.manifestPath).manifest_version, undefined);
  store.fail = () => false;
  await migrate({ ...paths, store, cutover: true });
  assert.equal(readJson(paths.manifestPath).days[DATE].committed, true);
  const pointer = await store.readJson('positions/index.json');
  const published = await store.readJson(pointer.path);
  assert.ok(Object.values(published.days[0].files).every((f) => f.path.endsWith('.parquet')));
  store.fail = (op, path) => op === 'verify' && path.endsWith('.parquet');
  await assert.rejects(migrate({ ...paths, store, retire: true }), /injected/);
  assert.ok(KINDS.every((kind) => store.objects.has(old[kind].path)));
  store.fail = () => false;
  await migrate({ ...paths, store, retire: true });
  await migrate({ ...paths, store, retire: true });
  for (const kind of KINDS) {
    assert.equal(store.objects.has(old[kind].path), false);
    assert.equal(Fs.existsSync(localPath(paths.outDir, old[kind].path)), false);
  }
});

test('migration rejects a corrupt source before publishing replacements', async (t) => {
  const paths = setup(t);
  const store = fakeStore();
  const files = await legacyFixture(paths, store);
  store.objects.set(files.bus.path, Buffer.from('corrupt'));
  await assert.rejects(migrate({ ...paths, store }), /checksum/);
  assert.equal(
    store.calls.some(([op]) => op === 'upload'),
    false,
  );
});

test('legacy reader propagates malformed gzip/JSON and refuses unknown fields', async (t) => {
  const { root } = setup(t);
  const path = Path.join(root, 'bad.gz');
  for (const body of [
    Buffer.from('not gzip'),
    Zlib.gzipSync('{bad}\n'),
    Zlib.gzipSync('{"unknown":1}\n'),
  ]) {
    Fs.writeFileSync(path, body);
    await assert.rejects(async () => {
      for await (const _row of readLegacy(path, 'bus')) {
      }
    });
  }
});

test('a correction creates a new revision and preserves the pinned prior manifest and bytes', async (t) => {
  const paths = setup(t);
  const store = fakeStore();
  makeDb(paths.dbPath, fixtureRows());
  writeJson(paths.manifestPath, newManifest());
  const args = { ...paths, store, now: dayBounds('2026-10-28').start, startDate: DATE };
  const original = await runExport(args);
  const previousFile = original.days[DATE].files.bus;
  const previousBytes = Buffer.from(store.objects.get(previousFile.path));
  const db = new Database(paths.dbPath);
  db.prepare("UPDATE observations SET lon = -88 WHERE kind = 'bus'").run();
  db.close();
  const revised = await runExport({ ...args, reexportDate: DATE, now: args.now + 1000 });
  const replacement = revised.days[DATE].files.bus;
  assert.notEqual(replacement.path, previousFile.path);
  assert.deepEqual(replacement.replaces, { path: previousFile.path, sha256: previousFile.sha256 });
  assert.deepEqual(store.objects.get(previousFile.path), previousBytes);
  assert.equal(
    (await store.readJson(original.published.path)).days[0].files.bus.path,
    previousFile.path,
  );
  assert.equal(
    (await store.readJson(revised.published.path)).previous_manifest,
    original.published.path,
  );
  await assert.rejects(
    runExport({ ...args, now: dayBounds('2026-11-15').start, reexportDate: DATE }),
    /hot window/,
  );
});

test('migration includes a published day missing from the local legacy manifest', async (t) => {
  const paths = setup(t);
  const store = fakeStore();
  await legacyFixture(paths, store);
  writeJson(paths.manifestPath, {});
  const result = await migrate({ ...paths, store, cutover: true });
  assert.equal(result.days[DATE].committed, true);
});

test('a malformed row cannot trigger SQLite pruning', async (t) => {
  const paths = setup(t);
  makeDb(paths.dbPath, [{ ...fixtureRows()[0], vehicle_id: null }]);
  writeJson(paths.manifestPath, newManifest());
  const store = fakeStore();
  await assert.rejects(
    runExport({ ...paths, store, now: dayBounds('2026-11-11').start, startDate: DATE, limit: 1 }),
    /vehicle_id/,
  );
  assert.equal(rowCount(paths.dbPath), 1);
  assert.deepEqual(store.calls, []);
});

test('missing local state for an already published day cannot create an empty replacement', async (t) => {
  const paths = setup(t);
  const store = fakeStore();
  makeDb(paths.dbPath, fixtureRows());
  writeJson(paths.manifestPath, newManifest());
  const args = { ...paths, store, now: dayBounds('2026-10-28').start, startDate: DATE };
  const manifest = await runExport(args);
  delete manifest.days[DATE];
  writeJson(paths.manifestPath, manifest);
  const callsBefore = store.calls.length;
  await assert.rejects(runExport(args), /disagrees with local state/);
  assert.equal(store.calls.length, callsBefore);
  assert.equal(rowCount(paths.dbPath), fixtureRows().length);
});

test('retirement refuses a rolled-back index and resumes after a delete/save interruption', async (t) => {
  const paths = setup(t);
  const store = fakeStore();
  const old = await legacyFixture(paths, store);
  const legacyIndex = store.objects.get('positions/index.json');
  await migrate({ ...paths, store, cutover: true });
  const pointer = store.objects.get('positions/index.json');
  store.objects.set('positions/index.json', legacyIndex);
  await assert.rejects(migrate({ ...paths, store, retire: true }), /Latest index/);
  assert.ok(store.objects.has(old.bus.path));
  store.objects.set('positions/index.json', pointer);
  const remove = store.remove;
  store.remove = async (path) => {
    await remove(path);
    throw new Error('interrupted after deletion');
  };
  await assert.rejects(migrate({ ...paths, store, retire: true }), /interrupted/);
  assert.equal(store.objects.has(old.bus.path), false);
  assert.equal(readJson(paths.manifestPath).days[DATE].sources.bus.retired_at, undefined);
  store.remove = remove;
  await migrate({ ...paths, store, retire: true });
  assert.ok(readJson(paths.manifestPath).days[DATE].sources.bus.retired_at);
});
