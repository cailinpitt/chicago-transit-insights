const test = require('node:test');
const assert = require('node:assert');
const Path = require('node:path');
const Os = require('node:os');
const Fs = require('node:fs');

const tmpDb = Path.join(Os.tmpdir(), `incupd-test-${process.pid}-${Date.now()}.sqlite`);
process.env.HISTORY_DB_PATH = tmpDb;

const history = require('../../src/shared/history');
const {
  dueForUpdate,
  formatElapsed,
  thinGapUpdate,
  busPulseUpdate,
  trainPulseUpdate,
} = require('../../src/shared/incidentUpdates');
const backfill = require('../../bin/backfill-incident-updates');

const HOUR = 60 * 60 * 1000;

test.after(() => {
  try {
    history.getDb().close();
  } catch (_e) {}
  try {
    Fs.unlinkSync(tmpDb);
  } catch (_e) {}
});

// --- Pure cadence gate ---

test('dueForUpdate enforces the hourly interval and the post-open grace', () => {
  const now = 10 * HOUR;
  assert.equal(dueForUpdate({ openedTs: now - 10 * 60 * 1000, lastUpdateTs: null, now }), false);
  assert.equal(dueForUpdate({ openedTs: now - HOUR, lastUpdateTs: null, now }), true);
  assert.equal(
    dueForUpdate({ openedTs: now - 3 * HOUR, lastUpdateTs: now - 30 * 60 * 1000, now }),
    false,
  );
  assert.equal(dueForUpdate({ openedTs: now - 3 * HOUR, lastUpdateTs: now - HOUR, now }), true);
  assert.equal(dueForUpdate({ openedTs: null, lastUpdateTs: null, now }), false);
});

test('formatElapsed rounds to whole hours past 60 min', () => {
  assert.equal(formatElapsed(45), '~45 min');
  assert.equal(formatElapsed(60), '~1h');
  assert.equal(formatElapsed(180), '~3h');
  assert.equal(formatElapsed(-5), null);
});

// --- Pure text/evidence builders ---

test('thinGapUpdate counts missed scheduled trips', () => {
  const u = thinGapUpdate({ routeTitle: '#22 Clark', headwayMin: 30, elapsedMin: 180 });
  assert.equal(
    u.description,
    '🚌 #22 Clark · still no buses observed — ~3h in, ~6 scheduled trips missed so far.',
  );
  assert.deepEqual(u.evidence, { elapsedMin: 180, headwayMin: 30, missedTrips: 6 });
});

test('busPulseUpdate names the normal active count', () => {
  const u = busPulseUpdate({ routeTitle: '#9 Ashland', expectedActive: 8, elapsedMin: 120 });
  assert.equal(
    u.description,
    '🚌 #9 Ashland · service still appears suspended — ~2h in; ~8 buses normally running this time.',
  );
});

test('trainPulseUpdate distinguishes a segment from a line-wide outage', () => {
  const seg = trainPulseUpdate({
    lineTitle: 'Red Line',
    fromStation: 'Belmont',
    toStation: 'Addison',
    expectedTrains: 5,
    elapsedMin: 120,
  });
  assert.equal(
    seg.description,
    '🚆 Red Line · still no trains observed between Belmont and Addison — ~2h in; ~5 trains normally running this time.',
  );
  const whole = trainPulseUpdate({ lineTitle: 'Blue Line', synthetic: true, elapsedMin: 60 });
  assert.match(whole.description, /still no trains observed line-wide — ~1h in/);
});

// --- Storage round-trip ---

test('incident_updates round-trip, latest ts, hour idempotency, grouped read', () => {
  const T = 1_781_000_000_000;
  history.recordIncidentUpdate({
    disruptionId: 1,
    kind: 'bus',
    line: '22',
    source: 'observed-thin',
    ts: T,
    evidence: { elapsedMin: 60 },
    description: 'first',
    postUri: 'at://a',
  });
  history.recordIncidentUpdate({
    disruptionId: 1,
    kind: 'bus',
    line: '22',
    source: 'observed-thin',
    ts: T + HOUR,
    evidence: { elapsedMin: 120 },
    description: 'second',
    postUri: null,
  });
  assert.equal(history.getLatestIncidentUpdateTs(1), T + HOUR);
  assert.equal(history.getLatestIncidentUpdateTs(999), null);
  assert.equal(history.incidentUpdateExistsForHour(1, T + 5 * 60 * 1000), true);
  assert.equal(history.incidentUpdateExistsForHour(1, T + 5 * HOUR), false);

  const grouped = history.listIncidentUpdatesByDisruption([1, 2]);
  assert.equal(grouped.get(1).length, 2);
  assert.deepEqual(
    grouped.get(1).map((r) => r.description),
    ['first', 'second'],
  );
  assert.equal(grouped.has(2), false);
});

// --- Backfill reconstruction from frozen disruption evidence ---

test('planBackfillUpdates reconstructs one update per completed hour, excluding the clear boundary', () => {
  const T = 1_782_000_000_000;
  // A 3h-exact thin-service event: open at T, cleared at T+3h.
  history.recordDisruption(
    {
      kind: 'bus',
      line: '999',
      source: 'observed-thin',
      posted: true,
      postUri: 'at://thin-999',
      evidence: { headwayMin: 30 },
    },
    T,
  );
  history.recordDisruption(
    { kind: 'bus', line: '999', source: 'observed-clear', posted: false, postUri: null },
    T + 3 * HOUR,
  );

  const rows = backfill.readAbsenceDisruptions(history.getDb()).filter((r) => r.line === '999');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].resolved_ts, T + 3 * HOUR);

  const planned = backfill.planBackfillUpdates(rows, T + 10 * HOUR);
  assert.equal(planned.length, 2); // +1h and +2h; clear covers +3h
  assert.deepEqual(
    planned.map((u) => u.ts),
    [T + HOUR, T + 2 * HOUR],
  );
  assert.match(planned[0].description, /still no buses observed — ~1h in/);
  assert.match(planned[1].description, /~2h in, ~4 scheduled trips missed/);

  // A train segment event (open, no clear) walks up to now and names the segment.
  const T2 = 1_783_000_000_000;
  history.recordDisruption(
    {
      kind: 'train',
      line: 'red',
      direction: 'branch-0-inbound',
      fromStation: 'Belmont',
      toStation: 'Addison',
      source: 'observed',
      posted: true,
      postUri: 'at://pulse-red',
      evidence: { expectedTrains: 5 },
    },
    T2,
  );
  const openRows = backfill
    .readAbsenceDisruptions(history.getDb())
    .filter((r) => r.line === 'red' && r.kind === 'train');
  assert.equal(openRows[0].resolved_ts, null);
  const openPlanned = backfill.planBackfillUpdates(openRows, T2 + 2 * HOUR + 5 * 60 * 1000);
  assert.equal(openPlanned.length, 2);
  assert.match(
    openPlanned[1].description,
    /still no trains observed between Belmont and Addison — ~2h in/,
  );
});
