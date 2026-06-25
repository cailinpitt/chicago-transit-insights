const test = require('node:test');
const assert = require('node:assert/strict');
const { shardIncidents, chicagoMonthKey, RECENT_WINDOW_MS } = require('../bin/export-web');

const NOW = Date.parse('2026-06-24T18:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

// Minimal incident in the schema-v2 output shape shardIncidents consumes.
function incident(id, firstSeenTs, { active = false, routes = ['red'] } = {}) {
  return {
    id,
    mode: 'train',
    routes,
    lifecycle: { first_seen_ts: firstSeenTs, resolved_ts: active ? null : firstSeenTs, active },
    detections: [],
  };
}

test('rkey_month maps secondary post rkeys to their month, excluding the canonical id', () => {
  const inc = {
    id: 'alertrkey',
    mode: 'train',
    routes: ['red'],
    lifecycle: {
      first_seen_ts: Date.parse('2026-05-10T12:00:00Z'),
      resolved_ts: null,
      active: false,
    },
    official_alert: { post_url: 'https://bsky.app/profile/did/post/alertrkey' },
    detections: [
      { post_url: 'https://bsky.app/profile/did/post/botrkey1' },
      { post_url: 'https://bsky.app/profile/did/post/botrkey2' },
    ],
  };
  const { rkeyMonth } = shardIncidents([inc], NOW);
  // Secondary detection rkeys resolve to the incident's month.
  assert.equal(rkeyMonth.botrkey1, '2026-05');
  assert.equal(rkeyMonth.botrkey2, '2026-05');
  // The canonical id (also the alert rkey) stays out of rkey_month (it's in idMonth).
  assert.equal(rkeyMonth.alertrkey, undefined);
});

test('recent = within window OR active, regardless of age', () => {
  const old = incident('old', NOW - 200 * DAY); // way outside the 93d window
  const oldButActive = incident('oldActive', NOW - 200 * DAY, { active: true });
  const fresh = incident('fresh', NOW - 2 * DAY);
  const { recent } = shardIncidents([fresh, oldButActive, old], NOW);
  const ids = recent.map((i) => i.id).sort();
  assert.deepEqual(ids, ['fresh', 'oldActive']);
  assert.ok(NOW - 200 * DAY < NOW - RECENT_WINDOW_MS, 'old incident is outside the window');
});

test('monthly shards bucket by Chicago month of first_seen and index every id', () => {
  const incidents = [
    incident('a', Date.parse('2026-06-10T12:00:00Z')),
    incident('b', Date.parse('2026-06-20T12:00:00Z')),
    incident('c', Date.parse('2026-05-02T12:00:00Z')),
  ];
  const { months, idMonth } = shardIncidents(incidents, NOW);
  // Newest month first.
  assert.deepEqual(
    months.map((m) => m.key),
    ['2026-06', '2026-05'],
  );
  const june = months.find((m) => m.key === '2026-06');
  assert.equal(june.count, 2);
  assert.equal(june.url, 'alerts/2026-06.json');
  assert.equal(idMonth.a, '2026-06');
  assert.equal(idMonth.c, '2026-05');
  // Every incident with a first_seen is indexed exactly once.
  assert.equal(Object.keys(idMonth).length, 3);
});

test('month key honors the Chicago timezone boundary', () => {
  // 2026-06-01T03:00Z is still 2026-05-31 22:00 in Chicago (CDT, -5).
  assert.equal(chicagoMonthKey(Date.parse('2026-06-01T03:00:00Z')), '2026-05');
  assert.equal(chicagoMonthKey(Date.parse('2026-06-01T06:00:00Z')), '2026-06');
});

test('per-line files include an incident in each route it touches', () => {
  const multi = incident('multi', NOW - 2 * DAY, { routes: ['red', 'blue'] });
  const solo = incident('solo', NOW - 2 * DAY, { routes: ['red'] });
  const { lines } = shardIncidents([multi, solo], NOW);
  const byKey = Object.fromEntries(lines.map((l) => [l.key, l]));
  assert.deepEqual(byKey.red.incidents.map((i) => i.id).sort(), ['multi', 'solo']);
  assert.deepEqual(
    byKey.blue.incidents.map((i) => i.id),
    ['multi'],
  );
  assert.equal(byKey.blue.url, 'incidents/by-line/blue.json');
});

test('input order (first_seen DESC) is preserved within buckets', () => {
  const newer = incident('newer', NOW - 1 * DAY);
  const older = incident('older', NOW - 3 * DAY);
  // Pass in DESC order as buildIncidents would.
  const { recent, months } = shardIncidents([newer, older], NOW);
  assert.deepEqual(
    recent.map((i) => i.id),
    ['newer', 'older'],
  );
  assert.deepEqual(
    months[0].incidents.map((i) => i.id),
    ['newer', 'older'],
  );
});

test('incident with no first_seen is not archived but still rides recent if active', () => {
  const ghost = {
    id: 'nofs',
    mode: 'train',
    routes: ['red'],
    lifecycle: { first_seen_ts: null, resolved_ts: null, active: true },
    detections: [],
  };
  const { recent, months, idMonth } = shardIncidents([ghost], NOW);
  assert.deepEqual(
    recent.map((i) => i.id),
    ['nofs'],
  );
  assert.equal(months.length, 0);
  assert.equal(idMonth.nofs, undefined);
});
