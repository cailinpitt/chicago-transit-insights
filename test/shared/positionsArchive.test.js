const test = require('node:test');
const assert = require('node:assert');
const Fs = require('node:fs');
const Path = require('node:path');

const {
  toRecord,
  chicagoMidnight,
  dayBounds,
  completedDays,
  filePath,
  rolloffCutoff,
  buildIndex,
  KINDS,
  SCHEMA,
  KNOWN_GAPS,
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

test('buildIndex lists only uploaded days, newest first', () => {
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
    ['2026-10-02', '2026-10-01'],
  );
  assert.deepStrictEqual(index.coverage, { first: '2026-10-01', latest: '2026-10-02', days: 2 });
});

test('buildIndex shape and key order', () => {
  const files = {
    bus: { path: 'positions/bus/2026/10/2026-10-31.ndjson.gz', rows: 5, bytes: 9, sha256: 'a' },
    train: { path: 'positions/train/2026/10/2026-10-31.ndjson.gz', rows: 3, bytes: 8, sha256: 'b' },
    metra: { path: 'positions/metra/2026/10/2026-10-31.ndjson.gz', rows: 1, bytes: 7, sha256: 'c' },
  };
  const index = buildIndex({ '2026-10-31': { uploaded: true, files } }, 0);
  assert.deepStrictEqual(Object.keys(index), [
    'title',
    'generated_at',
    'timezone',
    'days_are',
    'format',
    'base_url',
    'coverage',
    'feeds',
    'known_gaps',
    'days',
  ]);
  assert.deepStrictEqual(index.days[0], {
    date: '2026-10-31',
    weekday: 'Sat',
    rows: { bus: 5, train: 3, metra: 1 },
    files,
  });
  assert.deepStrictEqual(Object.keys(index.feeds), KINDS);
  assert.deepStrictEqual(index.feeds.bus.fields.ts, {
    type: 'integer',
    unit: 'epoch ms',
    nullable: false,
    description: 'Poll time',
  });
  assert.strictEqual(index.feeds.train.fields.approaching.since, '2026-11-01');
  for (const feed of Object.values(index.feeds)) {
    for (const field of Object.values(feed.fields)) {
      assert.ok(['integer', 'number', 'string'].includes(field.type));
      assert.strictEqual(typeof field.nullable, 'boolean');
      assert.ok(field.description);
    }
  }
  assert.ok(index.known_gaps.some((g) => g.start.startsWith('2026-10-12') && g.feeds[0] === 'bus'));
});

test('toRecord emits fields in schema order', () => {
  const rec = toRecord({ kind: 'metra', ts: 1, route: 'ME', vehicle_id: '1', trip_id: 't' });
  assert.deepStrictEqual(Object.keys(rec), Object.keys(SCHEMA.metra.fields));
});

test('buildIndex migrates an old-format index without losing days', () => {
  const oldFiles = (rows) => ({ bus: { path: 'x', rows, bytes: 1, sha256: `h${rows}` } });
  const previous = {
    generated_at: '2026-11-01T08:40:01.646Z',
    timezone: 'America/Chicago',
    format: 'gzipped NDJSON, one JSON object per line, ordered by ts',
    schema: { bus: { ts: 'Poll time, epoch ms' } },
    days: [
      { date: '2026-09-28', files: oldFiles(1) },
      { date: '2026-09-29', files: oldFiles(2) },
    ],
  };
  const manifest = {
    '2026-09-29': { uploaded: true, files: oldFiles(20) },
    '2026-09-30': { uploaded: true, files: oldFiles(3) },
  };
  const index = buildIndex(manifest, 0, previous);
  assert.deepStrictEqual(
    index.days.map((d) => [d.date, d.files.bus.sha256]),
    [
      ['2026-09-30', 'h3'],
      ['2026-09-29', 'h20'],
      ['2026-09-28', 'h1'],
    ],
  );
  assert.strictEqual(index.schema, undefined);
  assert.deepStrictEqual(buildIndex({}, 0, index).days, index.days);
});

test('field descriptions leave unit and availability to their own keys', () => {
  for (const [kind, feed] of Object.entries(SCHEMA)) {
    for (const [name, field] of Object.entries(feed.fields)) {
      assert.ok(!/epoch|\(from /.test(field.description), `${kind}.${name}: ${field.description}`);
    }
  }
});

test('docs/POSITIONS.md known gaps table matches KNOWN_GAPS', () => {
  const md = Fs.readFileSync(Path.join(__dirname, '..', '..', 'docs', 'POSITIONS.md'), 'utf8');
  const table = md
    .split('\n')
    .filter((l) => /^\| 2026-/.test(l))
    .map((l) => l.trim());
  const hhmm = (iso) => iso.slice(11, 16);
  const expected = KNOWN_GAPS.map(
    (g) =>
      `| ${g.start.slice(0, 10)} | ${g.feeds.join(', ')} | ${hhmm(g.start)} to ${
        hhmm(g.end) === '00:00' ? 'midnight' : hhmm(g.end)
      } | ${g.note} |`,
  );
  assert.deepStrictEqual(table, expected);
});
