const axios = require('axios');
const { recordTrainObservations } = require('../shared/observations');
const { withRetry } = require('../shared/retry');
const { findStationByDestination } = require('./findStation');
const { chicagoWallTime } = require('../shared/chicagoTime');

const BASE = 'https://lapi.transitchicago.com/api/1.0';
const ALL_LINES = ['red', 'blue', 'brn', 'g', 'org', 'p', 'pink', 'y'];

// Official CTA line colors (hex without leading #) for Mapbox overlays and post text.
const LINE_COLORS = {
  red: 'c60c30',
  blue: '00a1de',
  brn: '62361b',
  g: '009b3a',
  org: 'f9461c',
  p: '522398',
  pink: 'e27ea6',
  y: 'f9e300',
};

const LINE_NAMES = {
  red: 'Red',
  blue: 'Blue',
  brn: 'Brown',
  g: 'Green',
  org: 'Orange',
  p: 'Purple',
  pink: 'Pink',
  y: 'Yellow',
};

// Friendly line label for log lines (`brn` → `Brown`). Falls back to the raw
// code when something hands us a key we don't recognize, so logs never
// silently lose information.
const lineLabel = (line) => LINE_NAMES[line] || line;

// Unicode has no pink square; 🩷 (pink heart) is the closest color-block stand-in.
const LINE_EMOJI = {
  red: '🟥',
  blue: '🟦',
  brn: '🟫',
  g: '🟩',
  org: '🟧',
  p: '🟪',
  pink: '🩷',
  y: '🟨',
};

// Train Tracker's "2026-10-31T23:01:08" America/Chicago wall time, as epoch ms.
function parseTrainTime(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(s || '');
  if (!m) return null;
  return chicagoWallTime(...m.slice(1).map(Number)).getTime();
}

function parseTrain(line, raw) {
  return {
    line,
    rn: raw.rn,
    destination: raw.destNm,
    trDr: raw.trDr, // Direction code — '1' or '5'. Use with destination for context.
    nextStation: raw.nextStaNm,
    approaching: raw.isApp === '1',
    delayed: raw.isDly === '1',
    lat: parseFloat(raw.lat),
    lon: parseFloat(raw.lon),
    heading: parseInt(raw.heading, 10),
    // When Train Tracker generated this position.
    predictedAt: parseTrainTime(raw.prdt),
  };
}

// Rough Chicagoland bounding box. Trains reporting outside this are API glitches
// (e.g. a known issue where unpositioned trains come back with lat/lon 0,0).
function isInChicagoland(lat, lon) {
  return lat > 41 && lat < 43 && lon > -88.5 && lon < -87;
}

// A train the feed returns at 0,0 (or otherwise out of bounds) is usually still
// *running* — it just lost its GPS fix for a tick. It almost always still
// reports `nextStaNm`, so we can recover an approximate position from that
// station's coords rather than dropping the train and manufacturing a feed gap
// (the root cause of trains vanishing/reappearing in the replay + videos).
// Returns a position-patched copy tagged `approx: true`, or null when there's
// no station to recover from. Pure; station data injected for testing.
function recoverUnpositionedTrain(train, stations) {
  const sta = findStationByDestination(train.line, train.nextStation, stations);
  if (!sta || !Number.isFinite(sta.lat) || !Number.isFinite(sta.lon)) return null;
  return { ...train, lat: sta.lat, lon: sta.lon, approx: true, recoveredFrom: sta.name };
}

// `includeApprox` controls only the RETURNED array: detection bins call with the
// default (false) and see exactly the in-bounds trains they always have, so
// ghost/gap/pulse/bunching behavior is unchanged. Live video capture passes true
// to draw recovered trains. Recovered positions are ALWAYS written to
// `observations` (tagged approx) so the DB-driven replay can bridge the dropout.
async function getAllTrainPositions(lines = ALL_LINES, { includeApprox = false } = {}) {
  const { data } = await withRetry(
    () =>
      axios.get(`${BASE}/ttpositions.aspx`, {
        params: { key: process.env.CTA_TRAIN_KEY, rt: lines.join(','), outputType: 'JSON' },
        timeout: 15000,
      }),
    { label: 'CTA train positions' },
  );
  const body = data.ctatt;
  if (body.errCd !== '0') throw new Error(`Train API error ${body.errCd}: ${body.errNm}`);

  const trains = [];
  const approxTrains = [];
  let recovered = 0;
  let dropped = 0;
  for (const route of body.route || []) {
    const line = route['@name'];
    // API returns `train` as an object when there's exactly one train on the line,
    // and as an array otherwise. Normalize.
    const raws = Array.isArray(route.train) ? route.train : route.train ? [route.train] : [];
    for (const raw of raws) {
      const train = parseTrain(line, raw);
      if (isInChicagoland(train.lat, train.lon)) {
        trains.push(train);
        continue;
      }
      const fixed = recoverUnpositionedTrain(train);
      if (fixed) {
        recovered++;
        approxTrains.push(fixed);
      } else {
        dropped++;
      }
    }
  }
  if (recovered > 0 || dropped > 0) {
    console.log(
      `Unpositioned trains: recovered ${recovered} from next-station, dropped ${dropped} (no station)`,
    );
  }
  // Persist real + recovered (approx) so the replay sees continuity. The
  // detection reads in observations.js exclude approx rows by default.
  recordTrainObservations([...trains, ...approxTrains]);
  return includeApprox ? [...trains, ...approxTrains] : trains;
}

// Strip the trailing parenthetical from a station name. Station data carries
// line/branch tags (e.g. "Western (Blue - Forest Park Branch)") to disambiguate
// same-named stops across the system, but bunching/gap posts and maps already
// display the line, so the tag reads as clutter. Branch ambiguity (two
// "Western" on the Blue Line) is rare enough to tolerate in exchange.
const TRAILING_PARENS = /\s*\([^)]*\)\s*$/;
// Station names longer than the typical ~15 char label eat horizontal space
// on dense stretches (Green Line west branch) and spill their rect across
// adjacent station pins. Override with a shorter form; the line is already
// stated in the post so the omitted qualifier doesn't harm readability.
const STATION_NAME_OVERRIDES = {
  'Conservatory-Central Park Drive': 'Conservatory',
  'Jefferson Park Transit Center': 'Jefferson Park',
  'Illinois Medical District': 'IMD',
  'Cermak-McCormick Place': 'Cermak',
  '35th-Bronzeville-IIT': '35th-Bronzeville',
};
function shortStationName(name) {
  if (!name) return name;
  if (STATION_NAME_OVERRIDES[name]) return STATION_NAME_OVERRIDES[name];
  return name.replace(TRAILING_PARENS, '');
}

module.exports = {
  getAllTrainPositions,
  parseTrain,
  parseTrainTime,
  recoverUnpositionedTrain,
  isInChicagoland,
  LINE_COLORS,
  LINE_NAMES,
  lineLabel,
  LINE_EMOJI,
  ALL_LINES,
  shortStationName,
};
