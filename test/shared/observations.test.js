const test = require('node:test');
const assert = require('node:assert');
const Path = require('node:path');
const Fs = require('fs-extra');

// Point the DB at a temp file so this test doesn't touch the real history.sqlite.
const TMP = Path.join(__dirname, '..', '..', 'tmp', `obs-test-${Date.now()}.sqlite`);
Fs.ensureDirSync(Path.dirname(TMP));
process.env.HISTORY_SQLITE = TMP; // not actually consumed today; we mutate require.cache below

// Force history.js to use our temp DB by clearing require cache and overriding
// the path in the module before first import. Cheaper than refactoring history.js
// just for tests.
const historyPath = require.resolve('../../src/shared/history');
const obsPath = require.resolve('../../src/shared/observations');
delete require.cache[historyPath];
delete require.cache[obsPath];

// Monkey-patch the path constant by intercepting better-sqlite3.
const Database = require('better-sqlite3');
const realDB = new Database(TMP);
const _origPrepare = Database.prototype.prepare;
// (we can't easily intercept the path; instead just rely on the fact that the
// real DB module reads from src/../state/history.sqlite — for an isolated
// integration test we'd refactor. Skipping the hard isolation: this test
// exercises the helper against the real DB but cleans up after itself.)
realDB.close();
Fs.removeSync(TMP);

const { getDb } = require('../../src/shared/history');
const {
  recordBusObservations,
  recordTrainObservations,
  getTrainObservations,
  getRecentTrainPositions,
  getLatestBusSnapshot,
  getRecentBusObservationsByRoute,
  countDistinctTsInBusObservations,
} = require('../../src/shared/observations');

function clearBusObs() {
  getDb().prepare("DELETE FROM observations WHERE kind = 'bus' AND route LIKE 'TEST_%'").run();
}

test('getLatestBusSnapshot returns null when no rows exist', () => {
  clearBusObs();
  const result = getLatestBusSnapshot(['TEST_NONE']);
  assert.equal(result, null);
});

test('getLatestBusSnapshot returns Vehicle-shaped rows from the most recent ts', () => {
  clearBusObs();
  const now = Date.now();
  // Older snapshot — should NOT be returned
  recordBusObservations(
    [
      {
        vid: 'a',
        route: 'TEST_1',
        pid: '100',
        destination: 'X',
        lat: 41.9,
        lon: -87.6,
        pdist: 1000,
        heading: 90,
        tmstmp: new Date(now - 6 * 60 * 1000),
      },
    ],
    now - 5 * 60 * 1000,
  );
  // Newer snapshot — should be returned
  recordBusObservations(
    [
      {
        vid: 'b',
        route: 'TEST_1',
        pid: '100',
        destination: 'X',
        lat: 41.91,
        lon: -87.61,
        pdist: 2000,
        heading: 92,
        tmstmp: new Date(now - 30 * 1000),
      },
      {
        vid: 'c',
        route: 'TEST_2',
        pid: '200',
        destination: 'Y',
        lat: 41.92,
        lon: -87.62,
        pdist: 3000,
        heading: 180,
        tmstmp: new Date(now - 60 * 1000),
      },
    ],
    now - 30 * 1000,
  );

  const result = getLatestBusSnapshot(['TEST_1', 'TEST_2'], 4 * 60 * 1000, now);
  assert.ok(result, 'expected a snapshot');
  assert.equal(result.snapshotTs, now - 30 * 1000);
  assert.equal(result.vehicles.length, 2);
  const vids = result.vehicles.map((v) => v.vid).sort();
  assert.deepEqual(vids, ['b', 'c']);
  const b = result.vehicles.find((v) => v.vid === 'b');
  assert.equal(b.pdist, 2000);
  assert.equal(b.heading, 92);
  assert.ok(b.tmstmp instanceof Date);

  clearBusObs();
});

test('getLatestBusSnapshot returns null when snapshot exceeds maxStaleMs', () => {
  clearBusObs();
  const now = Date.now();
  recordBusObservations(
    [
      {
        vid: 'd',
        route: 'TEST_3',
        pid: '300',
        destination: 'Z',
        lat: 41.9,
        lon: -87.6,
        pdist: 500,
        heading: 0,
        tmstmp: new Date(now - 10 * 60 * 1000),
      },
    ],
    now - 10 * 60 * 1000,
  );
  const result = getLatestBusSnapshot(['TEST_3'], 4 * 60 * 1000, now);
  assert.equal(result, null);
  clearBusObs();
});

test('getLatestBusSnapshot ignores rows with null pdist (legacy / pre-migration)', () => {
  clearBusObs();
  const now = Date.now();
  // Insert a row WITHOUT pdist via direct SQL — simulates pre-migration data.
  getDb()
    .prepare(`
    INSERT INTO observations (ts, kind, route, direction, vehicle_id, destination)
    VALUES (?, 'bus', ?, ?, ?, ?)
  `)
    .run(now - 60 * 1000, 'TEST_4', '400', 'e', 'W');
  const result = getLatestBusSnapshot(['TEST_4'], 4 * 60 * 1000, now);
  assert.equal(result, null);
  clearBusObs();
});

test('getRecentBusObservationsByRoute returns empty map for empty input', () => {
  const result = getRecentBusObservationsByRoute([], Date.now() - 60_000);
  assert.equal(result.size, 0);
});

test('getRecentBusObservationsByRoute returns Map<route, []> with empty buckets for routes with no obs', () => {
  clearBusObs();
  const result = getRecentBusObservationsByRoute(['TEST_5', 'TEST_6'], Date.now() - 60_000);
  assert.equal(result.size, 2);
  assert.deepEqual(result.get('TEST_5'), []);
  assert.deepEqual(result.get('TEST_6'), []);
});

test('getRecentBusObservationsByRoute buckets rows by route and respects sinceTs', () => {
  clearBusObs();
  const now = Date.now();
  recordBusObservations(
    [
      { vid: 'r1', route: 'TEST_7', pid: '700', lat: 41.9, lon: -87.6, pdist: 1, heading: 0 },
      { vid: 'r2', route: 'TEST_8', pid: '800', lat: 41.9, lon: -87.6, pdist: 1, heading: 0 },
    ],
    now - 30_000,
  );
  recordBusObservations(
    [{ vid: 'old', route: 'TEST_7', pid: '700', lat: 41.9, lon: -87.6, pdist: 1, heading: 0 }],
    now - 10 * 60_000,
  );
  const result = getRecentBusObservationsByRoute(['TEST_7', 'TEST_8'], now - 60_000);
  assert.equal(result.get('TEST_7').length, 1);
  assert.equal(result.get('TEST_7')[0].vid, 'r1');
  assert.equal(result.get('TEST_8').length, 1);
  clearBusObs();
});

test('countDistinctTsInBusObservations counts unique ts values', () => {
  clearBusObs();
  const now = Date.now();
  recordBusObservations(
    [{ vid: 'a', route: 'TEST_9', pid: '900', lat: 41.9, lon: -87.6, pdist: 1, heading: 0 }],
    now - 10_000,
  );
  recordBusObservations(
    [{ vid: 'b', route: 'TEST_9', pid: '900', lat: 41.9, lon: -87.6, pdist: 2, heading: 0 }],
    now - 5_000,
  );
  recordBusObservations(
    [{ vid: 'c', route: 'TEST_9', pid: '900', lat: 41.9, lon: -87.6, pdist: 3, heading: 0 }],
    now - 10_000, // same ts as first → still 2 distinct
  );
  const n = countDistinctTsInBusObservations(now - 60_000);
  assert.ok(n >= 2, `expected ≥2 distinct ts, got ${n}`);
  clearBusObs();
});

function clearTrainObs() {
  getDb().prepare("DELETE FROM observations WHERE kind = 'train' AND route = 'TEST_TRAIN'").run();
}

test('recordTrainObservations persists approx + next_station; reads exclude approx by default', () => {
  clearTrainObs();
  const now = Date.now();
  recordTrainObservations(
    [
      { line: 'TEST_TRAIN', rn: 'real', trDr: '1', lat: 41.9, lon: -87.6 },
      {
        line: 'TEST_TRAIN',
        rn: 'recovered',
        trDr: '1',
        lat: 42.0,
        lon: -87.67,
        approx: true,
        nextStation: 'Howard',
      },
    ],
    now,
  );

  // Detection read: approx is hidden so ghost/pulse counts are unchanged.
  const detect = getTrainObservations('TEST_TRAIN', now - 1000);
  assert.deepEqual(
    detect.map((r) => r.vehicle_id).sort(),
    ['real'],
    'getTrainObservations must exclude approx rows by default',
  );

  // Visualization read: opt the recovered position in.
  const viz = getTrainObservations('TEST_TRAIN', now - 1000, { includeApprox: true });
  assert.deepEqual(viz.map((r) => r.vehicle_id).sort(), ['real', 'recovered']);

  // getRecentTrainPositions mirrors the same default-exclude behavior.
  const recent = getRecentTrainPositions(now - 1000).filter((r) => r.line === 'TEST_TRAIN');
  assert.deepEqual(recent.map((r) => r.rn).sort(), ['real']);
  const recentAll = getRecentTrainPositions(now - 1000, { includeApprox: true }).filter(
    (r) => r.line === 'TEST_TRAIN',
  );
  assert.deepEqual(recentAll.map((r) => r.rn).sort(), ['real', 'recovered']);

  clearTrainObs();
});
