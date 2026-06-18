const test = require('node:test');
const assert = require('node:assert/strict');
const { pointsFromCluster } = require('../../src/map/crossBunching');

// pointsFromCluster is pure (no Mapbox); the render itself hits the network and
// is exercised only via the bin. Here we lock down the normalization: discs
// carry the right number + color group, and the legend matches the post order.
test('pointsFromCluster normalizes members to discs + legend', () => {
  const items = [
    { vid: 'a', route: '22', lat: 41.9, lon: -87.65 },
    { vid: 'b', route: '36', lat: 41.901, lon: -87.65 },
    { vid: 'c', route: '36', lat: 41.902, lon: -87.65 },
  ];
  const labels = new Map([
    ['a', 3],
    ['b', 1],
    ['c', 2],
  ]);
  const { points, legend } = pointsFromCluster(items, {
    idOf: (it) => it.vid,
    groupKeyOf: (it) => it.route,
    labels,
    groupOrder: ['36', '22'], // biggest group first, matching the post text
    legendLabelOf: (r) => `Route ${r}`,
  });
  // Route 36 → groupIndex 0, Route 22 → groupIndex 1.
  const byId = Object.fromEntries(points.map((p, i) => [items[i].vid, p]));
  assert.equal(byId.a.label, '3');
  assert.equal(byId.a.groupIndex, 1); // Route 22
  assert.equal(byId.b.groupIndex, 0); // Route 36
  assert.deepEqual(legend, [
    { label: 'Route 36', groupIndex: 0 },
    { label: 'Route 22', groupIndex: 1 },
  ]);
});
