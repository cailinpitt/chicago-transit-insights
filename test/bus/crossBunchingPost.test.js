const test = require('node:test');
const assert = require('node:assert/strict');
const { detectCrossRouteBunches } = require('../../src/bus/crossBunching');
const { buildPostText, buildAltText } = require('../../src/bus/crossBunchingPost');
const { bus, FRESH } = require('../helpers');

const FT_PER_MILLIDEG_LAT = 365;
const dLatForFt = (ft) => ft / FT_PER_MILLIDEG_LAT / 1000;
const at = (vid, route, ft) =>
  bus({ vid, route, pid: `p${route}`, lat: 41.9 + dLatForFt(ft), lon: -87.65 });

test('headline names the place and route count; groups buses by route', () => {
  const vs = [at('5678', '22', 0), at('1234', '36', 200), at('1235', '36', 400)];
  const [cluster] = detectCrossRouteBunches(vs, { now: FRESH });
  const text = buildPostText(cluster, { placeName: 'Clark & Belmont' }, []);
  assert.match(text, /3 buses from 2 routes bunched near Clark & Belmont/);
  // Bigger group (Route 36, ×2) listed first, with keycap disc numbers.
  const route36Idx = text.indexOf('Route 36');
  const route22Idx = text.indexOf('Route 22');
  assert.ok(route36Idx > -1 && route22Idx > route36Idx, 'Route 36 listed before Route 22');
  assert.match(text, /#1234 \(1️⃣\)/);
  assert.match(text, /#5678 \(3️⃣\)/);
});

test('appends callouts when present', () => {
  const vs = [at('a', '22', 0), at('b', '36', 200), at('c', '8', 400)];
  const [cluster] = detectCrossRouteBunches(vs, { now: FRESH });
  const text = buildPostText(cluster, { placeName: 'X & Y' }, ['biggest pileup in 30 days']);
  assert.match(text, /📊 biggest pileup in 30 days/);
});

test('alt text lists the routes and span', () => {
  const vs = [at('a', '22', 0), at('b', '36', 200), at('c', '8', 400)];
  const [cluster] = detectCrossRouteBunches(vs, { now: FRESH });
  const alt = buildAltText(cluster, { placeName: 'X & Y' });
  assert.match(alt, /Route 22/);
  assert.match(alt, /3 buses from 3 routes/);
});
