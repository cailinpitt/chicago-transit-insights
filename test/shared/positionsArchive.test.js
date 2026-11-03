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
  newManifest,
  verifiedDay,
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

test('filePath uses immutable SHA-256 revisions', () => {
  const hash = 'a'.repeat(64);
  assert.strictEqual(filePath('bus', '2026-09-28', hash), `bus/2026/09/2026-09-28.${hash}.parquet`);
  assert.throws(() => filePath('bus', '2026-09-28', 'invalid'));
});

test('dayBounds spans 23 hours on the spring-forward day', () => {
  const { start, end } = dayBounds('2026-03-08');
  assert.strictEqual(end - start, 23 * HOUR);
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

function entry(date) {
  return {
    verified: true,
    committed: true,
    files: Object.fromEntries(
      KINDS.map((kind) => [
        kind,
        {
          path: `positions/${filePath(kind, date, 'a'.repeat(64))}`,
          rows: 2,
          bytes: 100,
          sha256: 'a'.repeat(64),
          data_revision: 'a'.repeat(64),
          format: 'parquet',
          schema_version: 2,
        },
      ]),
    ),
  };
}

test('rolloff requires all feeds verified, committed and included in a publication', () => {
  const now = Date.UTC(2026, 9, 31, 17);
  const manifest = newManifest();
  for (const d of completedDays(now, '2026-10-01')) manifest.days[d] = entry(d);
  assert.strictEqual(rolloffCutoff(manifest, now, '2026-10-01'), chicagoMidnight('2026-10-01'));
  manifest.published = { path: 'positions/manifests/test.json' };
  assert.strictEqual(rolloffCutoff(manifest, now, '2026-10-01'), chicagoMidnight('2026-10-17'));
  for (const failure of ['committed', 'verified']) {
    manifest.days['2026-10-05'][failure] = false;
    assert.strictEqual(rolloffCutoff(manifest, now, '2026-10-01'), chicagoMidnight('2026-10-05'));
    manifest.days['2026-10-05'][failure] = true;
  }
  delete manifest.days['2026-10-05'].files.metra;
  assert.strictEqual(rolloffCutoff(manifest, now, '2026-10-01'), chicagoMidnight('2026-10-05'));
  assert.strictEqual(rolloffCutoff({}, now, '2026-10-01'), chicagoMidnight('2026-10-01'));
});

test('buildIndex is Parquet-only, complete, newest first and explicitly versioned', () => {
  const manifest = newManifest();
  manifest.days['2026-10-01'] = entry('2026-10-01');
  manifest.days['2026-10-02'] = entry('2026-10-02');
  manifest.days['2026-10-03'] = { verified: false, files: {} };
  const index = buildIndex(manifest, 0);
  assert.deepStrictEqual(
    index.days.map((d) => d.date),
    ['2026-10-02', '2026-10-01'],
  );
  assert.strictEqual(index.manifest_version, 2);
  assert.strictEqual(index.schema_version, 2);
  assert.strictEqual(index.format, 'parquet');
  assert.deepStrictEqual(index.sort_order, ['route', 'vehicle_id', 'ts']);
  assert.deepStrictEqual(index.feeds.bus.fields.ts, SCHEMA.bus.fields.ts);
  assert.equal(index.feeds.train.fields.geometry, undefined);
  assert.strictEqual(index.feeds.train.fields.approaching.since, '2026-11-01');
  assert.throws(
    () => buildIndex(manifest, 0, { days: [{ date: '2026-09-30', files: {} }] }),
    /drop published/,
  );
  const bad = entry('2026-10-01');
  bad.files.bus.format = 'ndjson';
  assert.strictEqual(verifiedDay(bad), false);
});

test('toRecord emits fields in schema order', () => {
  const rec = toRecord({ kind: 'metra', ts: 1, route: 'ME', vehicle_id: '1', trip_id: 't' });
  assert.deepStrictEqual(Object.keys(rec), Object.keys(SCHEMA.metra.fields));
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
