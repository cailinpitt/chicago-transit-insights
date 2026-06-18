const test = require('node:test');
const assert = require('node:assert/strict');
const { clusterByProximity, clusterStats } = require('../../src/shared/geoClusters');

// ~365 ft per 0.001 deg latitude at Chicago — handy for spacing fixtures.
const FT_PER_MILLIDEG_LAT = 365;
const dLatForFt = (ft) => ft / FT_PER_MILLIDEG_LAT / 1000;

const at = (id, ft, route = '1') => ({ id, route, lat: 41.9 + dLatForFt(ft), lon: -87.65 });

test('groups points within the radius into one cluster', () => {
  const items = [at('a', 0), at('b', 200), at('c', 400)];
  const clusters = clusterByProximity(items, { radiusFt: 660 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].length, 3);
});

test('splits points farther apart than the radius', () => {
  const items = [at('a', 0), at('b', 200), at('c', 5000), at('d', 5200)];
  const clusters = clusterByProximity(items, { radiusFt: 660 }).sort((x, y) => y.length - x.length);
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].length, 2);
  assert.equal(clusters[1].length, 2);
});

test('single-link chains transitively within radius', () => {
  // a-b 500ft, b-c 500ft, a-c 1000ft: chained even though a..c exceeds radius.
  const items = [at('a', 0), at('b', 500), at('c', 1000)];
  const clusters = clusterByProximity(items, { radiusFt: 660 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].length, 3);
});

test('drops items without finite lat/lon', () => {
  const items = [at('a', 0), { id: 'x', route: '2', lat: NaN, lon: -87.65 }, at('b', 100)];
  const clusters = clusterByProximity(items, { radiusFt: 660 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].length, 2);
});

test('clusterStats reports span, distinct routes, and centroid', () => {
  const items = [at('a', 0, '22'), at('b', 600, '36'), at('c', 300, '22')];
  const { spanFt, routes, centroid } = clusterStats(items, { routeKey: (v) => v.route });
  assert.ok(Math.abs(spanFt - 600) < 5, `spanFt ~600, got ${spanFt}`);
  assert.deepEqual([...routes].sort(), ['22', '36']);
  assert.ok(Math.abs(centroid.lat - (41.9 + dLatForFt(300))) < 1e-6);
  assert.ok(Math.abs(centroid.lon - -87.65) < 1e-6);
});
