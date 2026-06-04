// Replay-based regression corpus for the train pulse detector. Each fixture
// captures the actual observations the bot saw around a known false-positive
// post — playing them back through the detector at the same `now` must produce
// zero candidates. New FPs get added as new fixtures; the test is the
// guardrail that stops the "patch one, leak another" cycle.
//
// To regenerate or add a fixture: edit scripts/export-fp-fixtures.js with the
// (line, ts, headwayMin) tuple, run it on the server (which has the prod DB),
// and scp the resulting JSON into test/train/fixtures/.

const test = require('node:test');
const assert = require('node:assert');
const Fs = require('node:fs');
const Path = require('node:path');

const { detectDeadSegments } = require('../../src/train/pulse');
const { detectHeldClusters } = require('../../src/train/heldClusters');
const { trainOverlayInfo } = require('../../src/shared/gtfs');
const trainLines = require('../../src/train/data/trainLines.json');
const trainStations = require('../../src/train/data/trainStations.json');

// Mirror bin/train/pulse.js so the test reflects what the bot actually runs.
const BASE_LOOKBACK_MS = 20 * 60 * 1000;
const COLD_HEADWAY_MULT_FOR_LOOKBACK = 2.5;
const LOOKBACK_BUFFER_MS = 5 * 60 * 1000;
const RAMP_UP_LOOKBACK_MS = 2 * 60 * 60 * 1000;

function lineLookbackMs(headwayMin) {
  const headwayDriven = headwayMin
    ? COLD_HEADWAY_MULT_FOR_LOOKBACK * headwayMin * 60 * 1000 + LOOKBACK_BUFFER_MS
    : 0;
  return Math.max(BASE_LOOKBACK_MS, headwayDriven);
}

function loadFixture(name) {
  const path = Path.join(__dirname, 'fixtures', `${name}.json`);
  return JSON.parse(Fs.readFileSync(path, 'utf8'));
}

function runFixture(fixture) {
  const now = fixture.now;
  const lookbackMs = lineLookbackMs(fixture.headwayMin);
  const recentObs = fixture.observations.filter((o) => o.ts >= now - lookbackMs);
  const longRecentObs = fixture.observations.filter((o) => o.ts >= now - RAMP_UP_LOOKBACK_MS);
  const motionInputs = recentObs.map((r) => ({
    ts: r.ts,
    lat: r.lat,
    lon: r.lon,
    rn: r.rn,
    trDr: r.trDr,
    destination: r.destination,
  }));
  const longLookbackPositions = longRecentObs.map((r) => ({
    ts: r.ts,
    lat: r.lat,
    lon: r.lon,
    trDr: r.trDr,
  }));

  const detection = detectDeadSegments({
    line: fixture.line,
    trainLines,
    stations: trainStations,
    headwayMin: fixture.headwayMin,
    now,
    opts: {
      lookbackMs,
      recentPositions: motionInputs,
      longLookbackPositions,
      overlay: trainOverlayInfo(fixture.line, new Date(now)),
    },
  });

  const heldDetection = detectHeldClusters({
    line: fixture.line,
    trainLines,
    stations: trainStations,
    headwayMin: fixture.headwayMin,
    now,
    recent: motionInputs,
  });

  return { detection, heldDetection };
}

const FP_FIXTURES = [
  'purple-2026-05-13-1950-sedgwick-quincy',
  'purple-2026-05-11-1050-chicago-quincy',
  'purple-2026-05-12-1555-central-noyes',
  'purple-2026-05-14-1015-howard-belmont',
  'purple-2026-05-15-1924-howard-armitage',
  // Express-overlay corpus (2026-06): the recurring "local vs express" Purple
  // FPs the schedule-driven overlay clip / express-headway threshold kill.
  'purple-2026-05-29-0726-belmont-wellington', // off-direction: outbound in AM peak
  'purple-2026-06-02-0942-diversey-sedgwick', // AM shoulder: Express-headway threshold
  'purple-2026-06-03-1010-howard-wilson', // past AM Express: corridor clip
  'purple-2026-06-03-1944-chicago-washingtonwells', // evening Loop trunk: passLong bypass
  'purple-2026-06-04-0710-noyes-dempster', // Evanston shuttle: base-shuttle margin
];

for (const name of FP_FIXTURES) {
  test(`FP corpus — ${name} produces no candidates`, () => {
    const fixture = loadFixture(name);
    assert.equal(fixture.expectedResult, 'no-candidates');
    const { detection, heldDetection } = runFixture(fixture);
    const total = detection.candidates.length + heldDetection.candidates.length;
    if (total > 0) {
      const summary = [
        ...detection.candidates.map(
          (c) => `cold ${c.direction} ${c.fromStation.name}→${c.toStation.name}`,
        ),
        ...heldDetection.candidates.map(
          (c) => `held ${c.direction} ${c.fromStation.name}→${c.toStation.name}`,
        ),
      ].join('; ');
      assert.fail(`expected 0 candidates, got ${total}: ${summary}`);
    }
  });
}
