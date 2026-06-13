const test = require('node:test');
const assert = require('node:assert/strict');
const { detectBusGhosts, MIN_SNAPSHOTS } = require('../src/bus/ghosts');
const { describeGhost } = require('../src/shared/ghostFormat');
const { buildRollupPost } = require('../src/shared/post');
const { detectTrainGhosts } = require('../src/train/ghosts');

// Build a synthetic observation stream: `snapshots` polling timestamps, and at
// each one, `vidsPerSnapshot` distinct vids sharing `pid`. Used to shape
// observed_active to a desired value.
function buildObs({
  pid,
  snapshots,
  vidsPerSnapshot,
  startTs = 1_700_000_000_000,
  intervalMs = 5 * 60 * 1000,
}) {
  const rows = [];
  for (let i = 0; i < snapshots; i++) {
    const ts = startTs + i * intervalMs;
    for (let v = 0; v < vidsPerSnapshot; v++) {
      rows.push({ ts, direction: pid, vehicle_id: `v${v}`, destination: null });
    }
  }
  return rows;
}

function mkPattern(label, route = '66') {
  return { pid: `p-${label}-${route}`, direction: label, route };
}

// Build an observation stream where each snapshot has a specific count. Used
// for ramp-up / tail-median tests where shape-over-time matters.
function buildObsShaped({
  pid,
  countsPerSnapshot,
  startTs = 1_700_000_000_000,
  intervalMs = 5 * 60 * 1000,
}) {
  const rows = [];
  for (let i = 0; i < countsPerSnapshot.length; i++) {
    const ts = startTs + i * intervalMs;
    const n = countsPerSnapshot[i];
    for (let v = 0; v < n; v++) {
      rows.push({ ts, direction: pid, vehicle_id: `v${v}`, destination: null });
    }
  }
  return rows;
}

test('flags a route+direction with observed below expected by both thresholds', async () => {
  // Expected active: duration 60 / headway 10 = 6. Observed: 3. Missing: 3 (=50%).
  const obs = buildObs({ pid: 'p1', snapshots: 12, vidsPerSnapshot: 3 });
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => obs,
    getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => 10,
    expectedDuration: () => 60,
    expectedActive: () => 6,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].route, '66');
  assert.equal(events[0].direction, 'Eastbound');
  assert.equal(events[0].expectedActive, 6);
  assert.equal(events[0].observedActive, 3);
  assert.equal(events[0].missing, 3);
});

test('suppresses events under the absolute-missing threshold', async () => {
  // Expected 6, observed 4, missing 2 — passes 25% percent gate but fails ≥3 absolute.
  const obs = buildObs({ pid: 'p1', snapshots: 12, vidsPerSnapshot: 4 });
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => obs,
    getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => 10,
    expectedDuration: () => 60,
    expectedActive: () => 6,
  });
  assert.equal(events.length, 0);
});

test('suppresses events under the 25% gate even when ≥3 missing in absolute terms', async () => {
  // Expected 15, observed 12, missing 3 — 20% missing. Fails percent gate.
  const obs = buildObs({ pid: 'p1', snapshots: 12, vidsPerSnapshot: 12 });
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => obs,
    getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => 4,
    expectedDuration: () => 60,
    expectedActive: () => 15,
  });
  assert.equal(events.length, 0);
});

test('skips routes with fewer than MIN_SNAPSHOTS in the window', async () => {
  const obs = buildObs({ pid: 'p1', snapshots: MIN_SNAPSHOTS - 1, vidsPerSnapshot: 1 });
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => obs,
    getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => 10,
    expectedDuration: () => 60,
    expectedActive: () => 6,
  });
  assert.equal(events.length, 0);
});

test('merges observations from multiple pids when they resolve to the same direction', async () => {
  // Two weekday pids both labeled "Eastbound" — their observations should be
  // combined into a single direction group. Each pid provides 2 vids; the
  // merged snapshot should show 4 distinct vids.
  const rows = [
    ...buildObs({ pid: 'p-weekday', snapshots: 12, vidsPerSnapshot: 2 }),
    ...buildObs({ pid: 'p-express', snapshots: 12, vidsPerSnapshot: 2 }).map((r, i) => ({
      ...r,
      vehicle_id: `x${i % 2}`,
    })),
  ];
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => rows,
    getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => 6,
    expectedDuration: () => 60,
    expectedActive: () => 10,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].observedActive, 4);
  assert.equal(events[0].expectedActive, 10);
});

test('skips when expected active count is below 2 (too sparse to be newsworthy)', async () => {
  const obs = buildObs({ pid: 'p1', snapshots: 12, vidsPerSnapshot: 0 });
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => obs,
    getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => 40,
    expectedDuration: () => 60,
    expectedActive: () => 1.5,
  });
  assert.equal(events.length, 0);
});

test('skips routes where expectedActive is null (no schedule data for this hour)', async () => {
  const obs = buildObs({ pid: 'p1', snapshots: 12, vidsPerSnapshot: 1 });
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => obs,
    getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => 10,
    expectedDuration: () => 60,
    expectedActive: () => null,
  });
  assert.equal(events.length, 0);
});

test('buildRollupPost keeps all lines when they fit under the limit', () => {
  const lines = ['a', 'b', 'c'];
  const text = buildRollupPost('head', lines, 100);
  assert.equal(text, 'head\n\na\nb\nc');
});

test('buildRollupPost appends "…and N more routes" when truncating', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line number ${i} padded to fit`);
  const text = buildRollupPost('HEAD', lines, 120);
  assert.ok(text.length <= 120, `expected <= 120, got ${text.length}`);
  assert.match(text, /…and \d+ more routes?/);
  const dropped = Number(text.match(/…and (\d+) more/)[1]);
  const kept = lines.length - dropped;
  for (let i = 0; i < kept; i++) assert.ok(text.includes(lines[i]));
});

test('buildRollupPost returns null when no line fits', () => {
  const text = buildRollupPost('HEAD', ['a-very-long-single-line'], 10);
  assert.equal(text, null);
});

test('buildRollupPost uses singular "route" when exactly 1 is dropped', () => {
  // 3 lines × 40 chars. Full rollup = 1+1+40+1+40+1+40 = 124. 2-line + tail =
  // 1+1+40+1+40+"\n…and 1 more route"(18) = 101. Budget 120 forces 1-drop.
  const lines = ['A'.repeat(40), 'B'.repeat(40), 'C'.repeat(40)];
  const text = buildRollupPost('H', lines, 120);
  assert.ok(text.endsWith('…and 1 more route'), `got: ${text}`);
  assert.ok(!text.endsWith('routes'));
});

// Synthetic train observations: N snapshots, with a configurable number of
// distinct vehicles on each of two Train Tracker directions (trDr=1, trDr=5).
function buildTrainObs({
  snapshots,
  vidsTrDr1,
  vidsTrDr5,
  destination = 'Loop',
  startTs = 1_700_000_000_000,
  intervalMs = 5 * 60 * 1000,
}) {
  const rows = [];
  for (let i = 0; i < snapshots; i++) {
    const ts = startTs + i * intervalMs;
    for (let v = 0; v < vidsTrDr1; v++)
      rows.push({ ts, direction: '1', vehicle_id: `a${v}`, destination });
    for (let v = 0; v < vidsTrDr5; v++)
      rows.push({ ts, direction: '5', vehicle_id: `b${v}`, destination: '54th/Cermak' });
  }
  return rows;
}

test('loop lines aggregate across trDrs instead of splitting', async () => {
  // Expected line-wide: 62 / 10 = 6.2 trains active on the entire Pink Line.
  // Observed: 2 trDr=1 + 1 trDr=5 = 3 distinct vehicles per snapshot.
  // Missing: 3.2 — passes the 3.0 abs threshold and >50% pct threshold.
  // Without the loop-aware path, grouping by trDr would compare 2 vs 6.2 and 1
  // vs 6.2 separately, wildly overstating missing.
  const obs = buildTrainObs({ snapshots: 12, vidsTrDr1: 2, vidsTrDr5: 1 });
  const events = await detectTrainGhosts({
    lines: ['pink'],
    getObservations: () => obs,
    findStation: () => null,
    expectedHeadway: () => 10,
    expectedDuration: () => 62,
    expectedActive: () => 6.2,
    isLoopLine: () => true,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].line, 'pink');
  assert.equal(events[0].trDr, null);
  assert.equal(events[0].destination, null);
  assert.equal(events[0].observedActive, 3);
  assert.ok(Math.abs(events[0].expectedActive - 6.2) < 1e-9);
});

test('loop lines suppress false positives that per-trDr grouping would fire', async () => {
  // Pink Loop at healthy service: ~6 trains line-wide, split 3 trDr=1 + 3 trDr=5.
  // Line-wide observed=6 matches expected=6.2 — no ghost.
  // Under the old per-trDr logic, this would fire two ghost events (3 vs 6.2 each).
  const obs = buildTrainObs({ snapshots: 12, vidsTrDr1: 3, vidsTrDr5: 3 });
  const events = await detectTrainGhosts({
    lines: ['pink'],
    getObservations: () => obs,
    findStation: () => null,
    expectedHeadway: () => 10,
    expectedDuration: () => 62,
    expectedActive: () => 6.2,
    isLoopLine: () => true,
  });
  assert.equal(events.length, 0);
});

test('bi-directional lines still split by trDr', async () => {
  // Blue Line Forest Park: expected 14, observed 9 → missing 5 on just the
  // trDr=5 side. isLoopLine returns false, so the existing per-trDr grouping
  // runs and fires a ghost for one direction while the other passes.
  const obs = buildTrainObs({
    snapshots: 12,
    vidsTrDr1: 14,
    vidsTrDr5: 9,
    destination: 'Forest Park',
  });
  const events = await detectTrainGhosts({
    lines: ['blue'],
    getObservations: () => obs,
    findStation: () => ({ lat: 41.87, lon: -87.81, isTerminal: true }),
    expectedHeadway: () => 6,
    expectedDuration: () => 84,
    expectedActive: () => 14,
    isLoopLine: () => false,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].trDr, '5');
  assert.equal(events[0].observedActive, 9);
  assert.equal(events[0].expectedActive, 14);
});

test('bi-directional line: skips direction whose destinations are all short-turns', async () => {
  const obs = buildTrainObs({
    snapshots: 12,
    vidsTrDr1: 14,
    vidsTrDr5: 9,
    destination: 'UIC-Halsted',
  });
  const events = await detectTrainGhosts({
    lines: ['blue'],
    getObservations: () => obs,
    findStation: () => ({ lat: 41.87, lon: -87.65, isTerminal: false }),
    expectedHeadway: () => 6,
    expectedDuration: () => 84,
    expectedActive: () => 14,
    isLoopLine: () => false,
  });
  assert.equal(events.length, 0);
});

test('bi-directional line: prefers a terminal destination when mixed with short-turns', async () => {
  const obs = buildTrainObs({ snapshots: 12, vidsTrDr1: 14, vidsTrDr5: 9, destination: null });
  // Half the observations say UIC-Halsted (short-turn), half Forest Park (terminal).
  for (let i = 0; i < obs.length; i++) {
    obs[i].destination = i % 2 === 0 ? 'UIC-Halsted' : 'Forest Park';
  }
  const findStation = (_line, dest) => {
    if (dest === 'Forest Park') return { lat: 41.87, lon: -87.81, isTerminal: true };
    return { lat: 41.87, lon: -87.65, isTerminal: false };
  };
  const events = await detectTrainGhosts({
    lines: ['blue'],
    getObservations: () => obs,
    findStation,
    expectedHeadway: () => 6,
    expectedDuration: () => 84,
    expectedActive: () => 14,
    isLoopLine: () => false,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].destination, 'Forest Park');
});

test('skips a route entirely when any observed pid fails pattern resolution', async () => {
  const obs = [
    ...buildObs({ pid: 'good', snapshots: 12, vidsPerSnapshot: 3 }),
    ...buildObs({ pid: 'broken', snapshots: 12, vidsPerSnapshot: 3 }).map((r, i) => ({
      ...r,
      vehicle_id: `x${i % 3}`,
    })),
  ];
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => obs,
    getPattern: async (pid) => {
      if (pid === 'broken') throw new Error('CTA getpatterns down');
      return mkPattern('Eastbound');
    },
    expectedHeadway: () => 6,
    expectedDuration: () => 60,
    expectedActive: () => 10,
  });
  assert.equal(events.length, 0);
});

test('skips a route when a pid resolves to a pattern with no direction label', async () => {
  const obs = buildObs({ pid: 'headless', snapshots: 12, vidsPerSnapshot: 3 });
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => obs,
    getPattern: async () => ({ pid: 'headless', direction: '', route: '66' }),
    expectedHeadway: () => 6,
    expectedDuration: () => 60,
    expectedActive: () => 10,
  });
  assert.equal(events.length, 0);
});

test('bus formatLine: ratio > 3 drops effective-headway estimate and says "scheduled every"', () => {
  const { formatLine } = require('../bin/bus/ghosts');
  const out = formatLine({
    route: '22',
    direction: 'Northbound',
    missing: 9,
    expectedActive: 10,
    observedActive: 1,
    headway: 10,
  });
  assert.match(out, /scheduled every ~10 min$/);
  assert.doesNotMatch(out, /instead of/);
});

test('bus formatLine: ratio <= 3 keeps effective-headway estimate', () => {
  const { formatLine } = require('../bin/bus/ghosts');
  const out = formatLine({
    route: '22',
    direction: 'Northbound',
    missing: 4,
    expectedActive: 10,
    observedActive: 6,
    headway: 10,
  });
  assert.match(out, /every ~17 min instead of ~10$/);
});

test('train formatLine: ratio > 3 drops effective-headway estimate', () => {
  const { formatLine } = require('../bin/train/ghosts');
  const out = formatLine({
    line: 'red',
    destination: 'Howard',
    missing: 10,
    expectedActive: 12,
    observedActive: 1,
    headway: 8,
  });
  assert.match(out, /scheduled every ~8 min$/);
  assert.doesNotMatch(out, /instead of/);
});

test('train formatLine: ratio <= 3 keeps effective-headway estimate', () => {
  const { formatLine } = require('../bin/train/ghosts');
  const out = formatLine({
    line: 'red',
    destination: 'Howard',
    missing: 4,
    expectedActive: 12,
    observedActive: 8,
    headway: 8,
  });
  assert.match(out, /every ~12 min instead of ~8$/);
});

test('sanity gate: MIN_OBSERVED blocks events when observed drops below 2', async () => {
  // Headway 6, duration 60 → expected 10. Observed 1 → missing 9, pct 90%,
  // passes the main thresholds but fails the observed-floor sanity gate.
  const obs = buildObs({ pid: 'p1', snapshots: 12, vidsPerSnapshot: 1 });
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => obs,
    getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => 6,
    expectedDuration: () => 60,
    expectedActive: () => 10,
  });
  assert.equal(events.length, 0);
});

test('sanity gate: MIN_SNAPSHOTS blocks coverage below the floor', async () => {
  const obs = buildObs({ pid: 'p1', snapshots: MIN_SNAPSHOTS - 1, vidsPerSnapshot: 3 });
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => obs,
    getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => 6,
    expectedDuration: () => 60,
    expectedActive: () => 10,
  });
  assert.equal(events.length, 0);
});

test('sanity gate: MAX_EXPECTED_ACTIVE cap blocks absurd schedules', async () => {
  const obs = buildObs({ pid: 'p1', snapshots: 12, vidsPerSnapshot: 10 });
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => obs,
    getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => 0.5,
    expectedDuration: () => 60,
    expectedActive: () => 120,
  });
  assert.equal(events.length, 0);
});

test('sanity gate: stddev > observed blocks noisy/bimodal polling windows', async () => {
  const obs = [];
  const ts0 = 1_700_000_000_000;
  const pattern = [0, 2, 0, 8, 0, 2, 0, 8, 0, 2, 0, 8];
  for (let i = 0; i < pattern.length; i++) {
    const ts = ts0 + i * 5 * 60 * 1000;
    for (let v = 0; v < pattern[i]; v++) {
      obs.push({ ts, direction: 'pid1', vehicle_id: `t${i}v${v}`, route: '66' });
    }
  }
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => obs,
    getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => 6,
    expectedDuration: () => 60,
    expectedActive: () => 10,
  });
  assert.equal(events.length, 0);
});

test('sorts events by missing count descending', async () => {
  const getObservations = (route) => {
    if (route === 'A') return buildObs({ pid: 'pa', snapshots: 12, vidsPerSnapshot: 3 }); // missing 3
    if (route === 'B') return buildObs({ pid: 'pb', snapshots: 12, vidsPerSnapshot: 2 }); // missing 4
    return [];
  };
  const events = await detectBusGhosts({
    routes: ['A', 'B'],
    getObservations,
    getPattern: async (pid) => mkPattern('Eastbound', pid === 'pa' ? 'A' : 'B'),
    expectedHeadway: () => 10,
    expectedDuration: () => 60,
    expectedActive: () => 6,
  });
  assert.equal(events.length, 2);
  assert.equal(events[0].route, 'B');
  assert.equal(events[1].route, 'A');
});

test('ramp-up gate: suppresses when tail-of-window median reaches expected (pipeline filling)', async () => {
  // Expected 12 (duration 60 / headway 5). Counts ramp from 2 → 12 across 12 snapshots.
  // Full-window median = 7 (would normally fire: 5 missing, 42%), but the tail median
  // (last 3 of 12) = 11 ≥ 0.8 × 12 = 9.6, so the pipeline is filling, not ghosting.
  const obs = buildObsShaped({
    pid: 'p1',
    countsPerSnapshot: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 11, 12],
  });
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => obs,
    getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => 5,
    expectedDuration: () => 60,
    expectedActive: () => 12,
  });
  assert.equal(events.length, 0);
});

test('ramp-up gate: still fires when tail remains well below expected (real outage)', async () => {
  // Expected 12. Counts dropped and stayed dropped: median 5, tail median 5. 5 < 0.8 × 12 = 9.6 → fires.
  const obs = buildObsShaped({
    pid: 'p1',
    countsPerSnapshot: [5, 5, 5, 6, 5, 5, 5, 6, 5, 5, 5, 5],
  });
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => obs,
    getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => 5,
    expectedDuration: () => 60,
    expectedActive: () => 12,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].observedActive, 5);
});

test('ramp-up gate: fires on mid-window outage even if tail partially recovers (below 80% threshold)', async () => {
  // Expected 12. Outage mid-window, partial recovery to 9 at tail. 9 < 0.8 × 12 = 9.6 → still fires.
  const obs = buildObsShaped({
    pid: 'p1',
    countsPerSnapshot: [12, 12, 4, 3, 3, 3, 4, 5, 6, 8, 9, 9],
  });
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => obs,
    getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => 5,
    expectedDuration: () => 60,
    expectedActive: () => 12,
  });
  assert.equal(events.length, 1);
});

test('ramp-up gate applies to trains too (loop line)', async () => {
  // Brown line loop — expected 9 (duration 45 / headway 5). Counts ramp 1 → 8.
  // Tail median 8 ≥ 0.8 × 9 = 7.2 → suppressed.
  const rows = [];
  const ts0 = 1_700_000_000_000;
  const counts = [1, 2, 3, 4, 5, 6, 7, 7, 8, 8, 8, 8];
  for (let i = 0; i < counts.length; i++) {
    const ts = ts0 + i * 5 * 60 * 1000;
    for (let v = 0; v < counts[i]; v++) {
      rows.push({ ts, direction: null, vehicle_id: `v${v}`, destination: null });
    }
  }
  const events = await detectTrainGhosts({
    lines: ['Brn'],
    getObservations: () => rows,
    findStation: () => ({ lat: 0, lon: 0, name: 'Kimball', isTerminal: true }),
    expectedHeadway: () => 5,
    expectedDuration: () => 45,
    expectedActive: () => 9,
    isLoopLine: () => true,
  });
  assert.equal(events.length, 0);
});

// --- describeGhost: counts + headway derived from one set of rounded integers ---

test('describeGhost derives the headway from the shown counts (4 of 9 → ~18, not ~16)', () => {
  // The old code used the raw fractional ratio, so "4 of 9" could print ~16.
  const { expectedShown, missingShown, pct, headwayPhrase } = describeGhost({
    expectedActive: 9,
    observed: 5,
    headway: 10,
  });
  assert.equal(expectedShown, 9);
  assert.equal(missingShown, 4);
  assert.equal(pct, 44);
  assert.equal(headwayPhrase, 'every ~18 min instead of ~10');
});

test('describeGhost floors the effective headway at the scheduled headway', () => {
  // observed > expected (no real deficit) must never read "better than schedule".
  const { headwayPhrase } = describeGhost({ expectedActive: 5, observed: 6, headway: 10 });
  assert.equal(headwayPhrase, 'every ~10 min instead of ~10');
});

test('describeGhost falls back to "scheduled every" above 3x', () => {
  const { headwayPhrase } = describeGhost({ expectedActive: 12, observed: 2, headway: 8 });
  assert.equal(headwayPhrase, 'scheduled every ~8 min');
});

test('describeGhost omits the headway phrase when headway is unknown', () => {
  const { headwayPhrase, missingShown, expectedShown } = describeGhost({
    expectedActive: 8,
    observed: 4,
    headway: null,
  });
  assert.equal(headwayPhrase, null);
  assert.equal(missingShown, 4);
  assert.equal(expectedShown, 8);
});

// --- observedDisplay: parked-filtered, recent-window service level ---

// Obs with pdist so the parked detector can run. Buses v0..vN-1 each appear in
// every snapshot; `parkedVids` stay at a constant pdist (drift 0), the rest
// advance. 60s cadence so ≥4 snapshots land in the 5-min parked window.
function buildObsWithPdist({ pid, snapshots, vids, parked = [], intervalMs = 60 * 1000 }) {
  const rows = [];
  const ts0 = 1_700_000_000_000;
  for (let i = 0; i < snapshots; i++) {
    const ts = ts0 + i * intervalMs;
    for (const v of vids) {
      const pdist = parked.includes(v) ? 5000 : 1000 + v * 1000 + i * 600;
      rows.push({ ts, direction: pid, vehicle_id: `v${v}`, destination: null, pdist });
    }
  }
  return rows;
}

test('observedDisplay drops confirmed-parked buses from the displayed service level', async () => {
  // 3 buses observed (fires: expected 6, missing 3), but v2 is parked → the
  // displayed count is 2, so the post reads "4 of 6", worse than the raw 3.
  const obs = buildObsWithPdist({ pid: 'p1', snapshots: 10, vids: [0, 1, 2], parked: [2] });
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => obs,
    getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => 10,
    expectedDuration: () => 60,
    expectedActive: () => 6,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].observedActive, 3); // firing count unchanged
  assert.equal(events[0].observedDisplay, 2); // parked v2 excluded
  const { missingShown, expectedShown } = describeGhost({
    expectedActive: events[0].expectedActive,
    observed: events[0].observedDisplay,
    headway: events[0].headway,
  });
  assert.equal(expectedShown, 6);
  assert.equal(missingShown, 4);
});
