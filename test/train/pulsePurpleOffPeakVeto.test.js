const test = require('node:test');
const assert = require('node:assert');
const { detectDeadSegments } = require('../../src/train/pulse');

// Linden→Loop straight N→S polyline. Real Purple terminals are ~Linden 42.073
// and ~Library 41.876; Howard sits at 42.019, roughly 25% of the way south.
const LINDEN_LAT = 42.073;
const LOOP_LAT = 41.876;
const HOWARD_LAT = 42.01906;
const FEET_PER_DEG_LAT = 364567;
const LON = -87.66;
const TOTAL_FT = Math.abs(LINDEN_LAT - LOOP_LAT) * FEET_PER_DEG_LAT;

function polylinePoints() {
  // 5 vertices so cumDist math has intermediate points.
  const pts = [];
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    pts.push([LINDEN_LAT + t * (LOOP_LAT - LINDEN_LAT), LON]);
  }
  return pts;
}
const trainLines = { p: [polylinePoints()] };

function latAtFt(ft) {
  const t = ft / TOTAL_FT;
  return LINDEN_LAT + t * (LOOP_LAT - LINDEN_LAT);
}

function station(name, ft) {
  return { name, lat: latAtFt(ft), lon: LON, lines: ['p'] };
}

// Stations along the polyline. Linden/South Boulevard/Howard sit in the north
// shuttle range; Chicago/Quincy are deep in the Loop trunk.
function buildStations() {
  return [
    station('Linden', 0),
    station('Central (Purple)', 4000),
    station('Davis', 12000),
    station('Howard', (LINDEN_LAT - HOWARD_LAT) * FEET_PER_DEG_LAT),
    station('Wilson', 38000),
    station('Belmont', 52000),
    station('Chicago (Brown/Purple)', 64000),
    station('Quincy', 68000),
  ];
}

function position(ft, ts) {
  return { ts, lat: latAtFt(ft), lon: LON, rn: `p${ft}-${ts}`, trDr: '1' };
}

function buildBaseline({ coldFromFt, coldToFt, coldAgoMs, lookbackMs }) {
  const now = 1_700_000_000_000;
  const recent = [];
  const oldTs = now - (lookbackMs - 2 * 60 * 1000);
  for (let ft = 4000; ft <= TOTAL_FT - 4000; ft += 1000) {
    if (ft >= coldFromFt && ft <= coldToFt) continue;
    recent.push(position(ft, oldTs));
    recent.push(position(ft, now - 60 * 1000));
  }
  for (let ft = coldFromFt; ft <= coldToFt; ft += 1000) {
    recent.push(position(ft, now - coldAgoMs));
  }
  return { now, recent };
}

function corridorBbox() {
  return {
    minLat: LOOP_LAT,
    maxLat: LINDEN_LAT,
    minLon: LON - 0.01,
    maxLon: LON + 0.01,
  };
}

const LOOKBACK_MS = 40 * 60 * 1000;

test('purpleOffPeak vetoes Chicago→Quincy cold candidate (the 2026-05-11 FP)', () => {
  // Cold zone deep in the Loop trunk — both endpoints far south of Howard.
  const { now, recent } = buildBaseline({
    coldFromFt: 62000,
    coldToFt: 70000,
    coldAgoMs: 30 * 60 * 1000,
    lookbackMs: LOOKBACK_MS,
  });
  const { candidates } = detectDeadSegments({
    line: 'p',
    trainLines,
    stations: buildStations(),
    headwayMin: 10,
    now,
    opts: {
      recentPositions: recent,
      corridorBbox: corridorBbox(),
      lookbackMs: LOOKBACK_MS,
      purpleOffPeak: true,
    },
  });
  assert.equal(
    candidates.length,
    0,
    'south-of-Howard candidate should be vetoed when Purple Express is not active',
  );
});

test('without purpleOffPeak flag the same candidate admits (regression guard)', () => {
  const { now, recent } = buildBaseline({
    coldFromFt: 62000,
    coldToFt: 70000,
    coldAgoMs: 30 * 60 * 1000,
    lookbackMs: LOOKBACK_MS,
  });
  const { candidates } = detectDeadSegments({
    line: 'p',
    trainLines,
    stations: buildStations(),
    headwayMin: 10,
    now,
    opts: {
      recentPositions: recent,
      corridorBbox: corridorBbox(),
      lookbackMs: LOOKBACK_MS,
      // purpleOffPeak omitted — Express is "likely active"
    },
  });
  assert.ok(
    candidates.length >= 1,
    'cold run must still admit during Express hours (gate generous; real outages must detect)',
  );
});

test('purpleOffPeak does not veto north-of-Howard shuttle outage', () => {
  // Cold zone Linden→Davis, entirely north of Howard. Shuttle is the only
  // service running off-peak, so a real outage here must still detect.
  const { now, recent } = buildBaseline({
    coldFromFt: 2000,
    coldToFt: 14000,
    coldAgoMs: 30 * 60 * 1000,
    lookbackMs: LOOKBACK_MS,
  });
  const { candidates } = detectDeadSegments({
    line: 'p',
    trainLines,
    stations: buildStations(),
    headwayMin: 10,
    now,
    opts: {
      recentPositions: recent,
      corridorBbox: corridorBbox(),
      lookbackMs: LOOKBACK_MS,
      purpleOffPeak: true,
    },
  });
  assert.ok(
    candidates.length >= 1,
    'shuttle-range outage must still admit when Purple Express is not active',
  );
});
