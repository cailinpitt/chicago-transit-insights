const test = require('node:test');
const assert = require('node:assert');

const { detectBusBlackouts } = require('../../src/bus/pulse');

function fakePattern(pid, direction = 'Northbound') {
  return { pid, direction, lengthFt: 50000, points: [] };
}

function build({
  routes = ['1', '2', '3', '4', '5', '6', '7'],
  routeNames = { 1: 'A', 2: 'B', 3: 'C', 4: 'D', 5: 'E', 6: 'F', 7: 'G' },
  observationsByRoute = new Map(),
  expectedActiveByRoute = {},
  expectedHeadwayByRoute = {},
  globalDistinctTs = 5,
  now = 1_700_000_000_000,
  opts = {},
} = {}) {
  for (const r of routes) {
    if (!observationsByRoute.has(String(r))) observationsByRoute.set(String(r), []);
  }
  return {
    routes,
    routeNames,
    observationsByRoute,
    loadPattern: async (pid) => fakePattern(pid),
    getKnownPidsForRoute: async (route) => [`${route}00`],
    expectedRouteActive: (route) => expectedActiveByRoute[route] ?? 6,
    expectedHeadway: (route) => expectedHeadwayByRoute[route] ?? 8,
    globalDistinctTs,
    now,
    opts,
  };
}

function obs(ts, pid = '100', vid = 'v1') {
  return { ts, pid, vid };
}

function healthyRoute(routesMap, route, now) {
  const arr = [];
  for (let i = 0; i < 4; i++) {
    arr.push(obs(now - i * 60_000, '100', `${route}-${i}`));
  }
  routesMap.set(String(route), arr);
}

test('returns warming-up when global distinct ts is below the floor', async () => {
  const result = await detectBusBlackouts(build({ globalDistinctTs: 1 }));
  assert.equal(result.skipped, 'warming-up');
  assert.equal(result.candidates.length, 0);
});

test('returns no-routes when watchlist is empty', async () => {
  const result = await detectBusBlackouts(build({ routes: [] }));
  assert.equal(result.skipped, 'no-routes');
});

test('returns pipeline-wide-quiet when too few other routes are active', async () => {
  const now = 1_700_000_000_000;
  const map = new Map();
  // Only 2 routes have observations — fewer than minOtherRoutesActive=5.
  healthyRoute(map, '1', now);
  healthyRoute(map, '2', now);
  const result = await detectBusBlackouts(build({ observationsByRoute: map, now }));
  assert.equal(result.skipped, 'pipeline-wide-quiet');
});

test('flags a single fully-blacked-out route while others are healthy', async () => {
  const now = 1_700_000_000_000;
  const map = new Map();
  // 6 healthy routes …
  for (const r of ['2', '3', '4', '5', '6', '7']) healthyRoute(map, r, now);
  // … and route 1 silent.
  map.set('1', []);
  const result = await detectBusBlackouts(build({ observationsByRoute: map, now }));
  assert.equal(result.skipped, null);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].route, '1');
});

test('expectedRouteActive is queried per-route, not multiplied across patterns (53A regression)', async () => {
  const now = 1_700_000_000_000;
  const map = new Map();
  for (const r of ['2', '3', '4', '5', '6', '7']) healthyRoute(map, r, now);
  map.set('1', []);
  let calls = 0;
  const result = await detectBusBlackouts({
    routes: ['1', '2', '3', '4', '5', '6', '7'],
    routeNames: { 1: 'A' },
    observationsByRoute: map,
    loadPattern: async (pid) => fakePattern(pid),
    // Many PIDs — pre-fix this would have caused per-pattern summing to
    // multiply the route-level value by ~9, masking a true sub-threshold
    // expectedActive (the bug behind the Sun-night 53A wind-down false post).
    getKnownPidsForRoute: async () => ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'],
    expectedRouteActive: (route) => {
      if (route === '1') {
        calls += 1;
        return 0.5; // sub-threshold; should NOT be flagged
      }
      return 6;
    },
    expectedHeadway: () => 8,
    globalDistinctTs: 5,
    now,
    opts: { minuteOfHour: 53 },
  });
  // Called once per relevant route invocation (gate + lookback probe samples
  // + wind-down lookahead) — but never multiplied by pattern count.
  assert.ok(calls >= 1 && calls <= 5, `expected ≤5 calls for route 1, got ${calls}`);
  assert.equal(
    result.candidates.find((c) => c.route === '1'),
    undefined,
  );
});

test('wind-down: skip when next-hour route-level active < threshold', async () => {
  const now = 1_700_000_000_000;
  const map = new Map();
  for (const r of ['2', '3', '4', '5', '6', '7']) healthyRoute(map, r, now);
  map.set('1', []);
  const result = await detectBusBlackouts({
    routes: ['1', '2', '3', '4', '5', '6', '7'],
    routeNames: { 1: 'A' },
    observationsByRoute: map,
    loadPattern: async (pid) => fakePattern(pid),
    getKnownPidsForRoute: async () => ['p1'],
    expectedRouteActive: (route, when) => {
      if (route !== '1') return 6;
      // Current hour = 6 (passes ≥2 gate); next hour = 0 (triggers wind-down skip)
      const t = typeof when === 'number' ? when : when.getTime();
      return t > now ? 0 : 6;
    },
    expectedHeadway: () => 8,
    globalDistinctTs: 5,
    now,
    opts: { minuteOfHour: 53 },
  });
  assert.equal(
    result.candidates.find((c) => c.route === '1'),
    undefined,
  );
});

test('a route with expectedActive < 2 is not flagged even when silent', async () => {
  const now = 1_700_000_000_000;
  const map = new Map();
  for (const r of ['2', '3', '4', '5', '6', '7']) healthyRoute(map, r, now);
  map.set('1', []);
  const result = await detectBusBlackouts(
    build({
      observationsByRoute: map,
      expectedActiveByRoute: { 1: 1 },
      now,
    }),
  );
  assert.equal(result.candidates.length, 0);
});

test('Route 6 gap case: 2 distinct vids in the window → not flagged', async () => {
  const now = 1_700_000_000_000;
  const map = new Map();
  for (const r of ['2', '3', '4', '5', '6', '7']) healthyRoute(map, r, now);
  // Route 1 has two distinct vehicles observed in the lookback (a gap, not a blackout).
  map.set('1', [obs(now - 33 * 60_000, '100', '4046'), obs(now - 60_000, '100', '4328')]);
  const result = await detectBusBlackouts(build({ observationsByRoute: map, now }));
  assert.equal(result.candidates.length, 0);
});

test('headway-scaled lookback: 30-min headway route with one obs 26 min ago → not flagged', async () => {
  const now = 1_700_000_000_000;
  const map = new Map();
  for (const r of ['2', '3', '4', '5', '6', '7']) healthyRoute(map, r, now);
  // 30-min headway → lookback clamped to 60 min — one obs 26 min ago counts.
  map.set('1', [obs(now - 26 * 60_000, '100', 'v-late')]);
  const result = await detectBusBlackouts(
    build({
      observationsByRoute: map,
      expectedHeadwayByRoute: { 1: 30 },
      now,
    }),
  );
  assert.equal(result.candidates.length, 0);
});

test('candidate carries lookbackMin, minHeadwayMin, name, expectedActive', async () => {
  const now = 1_700_000_000_000;
  const map = new Map();
  for (const r of ['2', '3', '4', '5', '6', '7']) healthyRoute(map, r, now);
  map.set('1', []);
  const result = await detectBusBlackouts(
    build({
      observationsByRoute: map,
      expectedHeadwayByRoute: { 1: 8 },
      expectedActiveByRoute: { 1: 6 },
      routeNames: { 1: 'Bronzeville/Union Station' },
      now,
    }),
  );
  assert.equal(result.candidates.length, 1);
  const c = result.candidates[0];
  assert.equal(c.name, 'Bronzeville/Union Station');
  assert.equal(c.minHeadwayMin, 8);
  assert.equal(c.lookbackMin, 25); // 3*8=24 → clamp to floor 25
  assert.equal(c.expectedActive, 6);
});

// Replay of the 2026-05-28 CTA Bus Tracker feed outage (21:06→21:44 CDT). The
// feed froze fleet-wide; every route went cold at once and the detector posted
// 5 FPs (54/63/66/72/79). `now` is anchored to 21:43, the tick where all 5
// were simultaneously strict-zero. The fixture carries the real (thinned)
// observations plus the GTFS-derived headway/expectedActive from the original
// posts. The feed-freshness guard must suppress; with the guard disabled the
// same data reproduces the cold candidates, proving the regression.
const feedOutageFixture = require('./fixtures/bus-feed-outage-2026-05-28-2143.json');

function buildFromFixture(fx) {
  const observationsByRoute = new Map();
  for (const [route, obs] of Object.entries(fx.observationsByRoute)) {
    observationsByRoute.set(String(route), obs);
  }
  const cold = new Set(fx.coldRoutes.map(String));
  return {
    routes: fx.routes,
    routeNames: Object.fromEntries(fx.routes.map((r) => [r, `Route ${r}`])),
    observationsByRoute,
    loadPattern: async (pid) => fakePattern(pid),
    getKnownPidsForRoute: async (route) => [`${route}00`],
    // Cold routes carry their real expected-active (≥2, passes the gate);
    // the rest are sub-threshold so the guard-disabled run yields exactly the
    // routes that posted in production. Constant across `when` so the ramp /
    // wind-down probes don't suppress.
    expectedRouteActive: (route) => (cold.has(String(route)) ? fx.expectedActiveByRoute[route] : 1),
    expectedHeadway: (route) => fx.headwayByRoute[route] ?? 8,
    globalDistinctTs: fx.globalDistinctTs,
    recentlyActiveRoutes: new Set(fx.routes.map(String)),
    now: fx.now,
    opts: { minuteOfHour: fx.minuteOfHour },
  };
}

test('feed outage 2026-05-28: feed-freshness guard suppresses the fleet-wide blackout', async () => {
  const result = await detectBusBlackouts(buildFromFixture(feedOutageFixture));
  assert.equal(result.skipped, 'feed-stale');
  assert.equal(result.candidates.length, 0);
});

test('feed outage 2026-05-28: without the guard the same data reproduces the FPs', async () => {
  const input = buildFromFixture(feedOutageFixture);
  input.opts = { ...input.opts, feedStaleMs: Number.POSITIVE_INFINITY };
  const result = await detectBusBlackouts(input);
  assert.equal(result.skipped, null);
  const flagged = result.candidates.map((c) => c.route).sort();
  assert.deepEqual(flagged, [...feedOutageFixture.coldRoutes].sort());
});
