const test = require('node:test');
const assert = require('node:assert');

const {
  toRecord,
  chicagoMidnight,
  dayBounds,
  completedDays,
  filePath,
  rolloffCutoff,
  buildIndex,
} = require('../../src/shared/positionsArchive');

const HOUR = 60 * 60 * 1000;

test('chicagoMidnight handles CDT and CST', () => {
  assert.strictEqual(chicagoMidnight('2026-10-30'), Date.UTC(2026, 9, 30, 5));
  assert.strictEqual(chicagoMidnight('2026-11-02'), Date.UTC(2026, 10, 2, 6));
});

test('dayBounds spans 25 hours on the fall-back day', () => {
  const { start, end } = dayBounds('2026-11-01');
  assert.strictEqual(end - start, 25 * HOUR);
});

test('completedDays runs from the start date through yesterday in Chicago', () => {
  // 03:00 UTC on Oct 31 is still Oct 30 in Chicago.
  const now = Date.UTC(2026, 9, 31, 3);
  assert.deepStrictEqual(completedDays(now, '2026-10-27'), [
    '2026-10-27',
    '2026-10-28',
    '2026-10-29',
  ]);
});

test('filePath nests by kind, year and month', () => {
  assert.strictEqual(filePath('bus', '2026-09-28'), 'bus/2026/09/2026-09-28.ndjson.gz');
});

test('toRecord publishes bus direction as pid and drops other kinds’ fields', () => {
  const rec = toRecord({
    kind: 'bus',
    ts: 1,
    route: '66',
    direction: '5424',
    vehicle_id: '8123',
    approx: null,
    trip_id: null,
  });
  assert.strictEqual(rec.pid, '5424');
  assert.ok(!('direction' in rec));
  assert.ok(!('approx' in rec));
  assert.ok(!('trip_id' in rec));
});

test('toRecord converts legacy Metra vehicle_ts seconds to ms and leaves ms alone', () => {
  const base = { kind: 'metra', ts: 1, route: 'BNSF', vehicle_id: '1234', trip_id: 'T1' };
  assert.strictEqual(toRecord({ ...base, vehicle_ts: 1792213170 }).vehicle_ts, 1792213170000);
  assert.strictEqual(toRecord({ ...base, vehicle_ts: 1792213170000 }).vehicle_ts, 1792213170000);
  assert.strictEqual(toRecord({ ...base, vehicle_ts: null }).vehicle_ts, null);
  assert.strictEqual(
    toRecord({ ...base, kind: 'bus', vehicle_ts: 1792213160000 }).vehicle_ts,
    1792213160000,
  );
});

test('rolloffCutoff keeps the 14-day window when every old day is uploaded', () => {
  const now = Date.UTC(2026, 9, 31, 17);
  const manifest = {};
  for (const d of completedDays(now, '2026-10-01')) manifest[d] = { uploaded: true };
  assert.strictEqual(rolloffCutoff(manifest, now, '2026-10-01'), chicagoMidnight('2026-10-17'));
});

test('rolloffCutoff stops at the first day that is not uploaded', () => {
  const now = Date.UTC(2026, 9, 31, 17);
  const manifest = {};
  for (const d of completedDays(now, '2026-10-01')) manifest[d] = { uploaded: true };
  manifest['2026-10-05'] = { uploaded: false };
  assert.strictEqual(rolloffCutoff(manifest, now, '2026-10-01'), chicagoMidnight('2026-10-05'));
  delete manifest['2026-10-05'];
  assert.strictEqual(rolloffCutoff(manifest, now, '2026-10-01'), chicagoMidnight('2026-10-05'));
});

test('rolloffCutoff deletes nothing before an empty manifest’s start date', () => {
  const now = Date.UTC(2026, 9, 31, 17);
  assert.strictEqual(rolloffCutoff({}, now, '2026-10-01'), chicagoMidnight('2026-10-01'));
});

test('buildIndex lists only uploaded days, sorted', () => {
  const index = buildIndex(
    {
      '2026-10-02': { uploaded: true, files: { bus: { rows: 2 } } },
      '2026-10-01': { uploaded: true, files: { bus: { rows: 1 } } },
      '2026-10-03': { uploaded: false, files: {} },
    },
    0,
  );
  assert.deepStrictEqual(
    index.days.map((d) => d.date),
    ['2026-10-01', '2026-10-02'],
  );
  assert.ok(index.schema.bus.pid);
});
