const test = require('node:test');
const assert = require('node:assert/strict');
const {
  pickReplayableIncident,
  resolveAffectedDir,
  buildTrack,
} = require('../../src/shared/eventTracks');

const NOW = 1_700_000_000_000;

function incident(over = {}) {
  return {
    id: 'rkey1',
    kind: 'train',
    routes: ['orange'],
    first_seen_ts: NOW,
    resolved_ts: NOW + 1800_000,
    active: false,
    observations: [
      {
        line: 'orange',
        from_station: '35th/Archer',
        to_station: 'Ashland (Orange)',
        direction_label: 'toward the Loop',
        onset_ts: NOW - 600_000,
        ts: NOW,
        resolved_ts: NOW + 1800_000,
        stations: ['35th/Archer', 'Ashland (Orange)'],
      },
    ],
    cta: null,
    ...over,
  };
}

test('pickReplayableIncident pulls fields from the primary observation', () => {
  const r = pickReplayableIncident(incident());
  assert.equal(r.eventId, 'rkey1');
  assert.equal(r.lineLong, 'orange');
  assert.equal(r.lineShort, 'org');
  assert.equal(r.from, '35th/Archer');
  assert.equal(r.to, 'Ashland (Orange)');
  assert.equal(r.directionLabel, 'toward the Loop');
  assert.equal(r.onset, NOW - 600_000); // onset_ts preferred over ts
  assert.equal(r.resolved, NOW + 1800_000);
  assert.equal(r.active, false);
});

test('pickReplayableIncident rejects buses and segment-less incidents', () => {
  assert.equal(pickReplayableIncident(incident({ kind: 'bus' })), null);
  assert.equal(
    pickReplayableIncident(incident({ observations: [{ line: 'orange', ts: NOW }] })),
    null,
  );
  assert.equal(pickReplayableIncident(null), null);
});

test('pickReplayableIncident falls back to the CTA block for a CTA-only incident', () => {
  const r = pickReplayableIncident(
    incident({
      observations: [],
      routes: ['red'],
      cta: {
        affected_from_station: 'Belmont',
        affected_to_station: 'Howard',
        affected_direction: 'toward Howard',
        first_seen_ts: NOW,
        resolved_ts: null,
      },
    }),
  );
  assert.equal(r.lineLong, 'red');
  assert.equal(r.from, 'Belmont');
  assert.equal(r.to, 'Howard');
  assert.equal(r.directionLabel, 'toward Howard');
  assert.equal(r.onset, NOW);
});

test('resolveAffectedDir matches "toward the Loop" to the Loop-bound dir', () => {
  assert.equal(resolveAffectedDir('toward the Loop', { 1: 'Loop', 5: 'Midway' }), '1');
  assert.equal(resolveAffectedDir('toward Midway', { 1: 'Loop', 5: 'Midway' }), '5');
});

test('resolveAffectedDir matches a named terminus, and bails when unresolved', () => {
  assert.equal(resolveAffectedDir('toward Kimball', { 1: 'Kimball', 5: 'Loop' }), '1');
  assert.equal(resolveAffectedDir(null, { 1: 'Loop' }), null);
  assert.equal(resolveAffectedDir('toward Nowhere', { 1: 'Loop', 5: 'Midway' }), null);
});

test('buildTrack groups by vehicle with relative-second, rounded samples', () => {
  const rows = [
    { ts: NOW, vehicle_id: '721', dir: '1', lat: 41.804812, lon: -87.681611 },
    { ts: NOW + 30_000, vehicle_id: '721', dir: '1', lat: 41.806174, lon: -87.67969 },
    { ts: NOW, vehicle_id: '725', dir: '5', lat: 41.83, lon: -87.66 },
  ];
  const track = buildTrack(
    {
      eventId: 'rkey1',
      lineLong: 'orange',
      from: 'A',
      to: 'B',
      stations: ['A', 'B'],
      onset: NOW,
      resolved: NOW + 1800_000,
      affectedDir: '1',
    },
    rows,
    NOW,
  );
  assert.equal(track.line, 'orange');
  assert.equal(track.affectedDir, '1');
  assert.equal(track.durSec, 30);
  assert.equal(track.vehicles.length, 2);
  // Sorted by sample count desc → 721 (2 samples) first.
  assert.equal(track.vehicles[0].id, '721');
  assert.deepEqual(track.vehicles[0].s[0], [0, 41.80481, -87.68161]); // t0-relative, 5dp
  assert.equal(track.vehicles[0].s[1][0], 30);
});

test('buildTrack returns null when nothing is positioned', () => {
  assert.equal(buildTrack({ eventId: 'x', lineLong: 'red' }, []), null);
  assert.equal(
    buildTrack({ eventId: 'x', lineLong: 'red' }, [{ ts: NOW, vehicle_id: '1', lat: null }]),
    null,
  );
});
