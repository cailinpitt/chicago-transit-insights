// Translate a pulse-cold `direction` key into a human-readable "toward X"
// label for the public alerts.json. Pre-computed in the exporter so the web
// app stays a dumb renderer and other JSON consumers don't need to know the
// per-line terminus geometry.
//
// Input shape — `direction` is the pulse_state direction key produced by
// `directionKeyFor` in src/train/pulse.js:
//   - `branch-N-outbound` / `branch-N-inbound` → round-trip lines split into
//     two direction-filtered branches (Brown, Orange, Pink, Purple).
//   - `branch-len{k}-{latK}-{lonK}` → multi-branch bidirectional lines where
//     each branch is keyed by its outer endpoint coords (Red, Blue, Green,
//     Yellow). Pulse doesn't distinguish direction within these — the key
//     identifies *which branch* is cold, not which way trains run on it.
//   - `all` / null / unrecognized → no label.
//
// `line` is the long color name as carried in alerts.json (`brown`, `purple`,
// …), not the short GTFS code.

const trainStations = require('../train/data/trainStations.json');

// Long color → short GTFS code (mirrors the LINE_ALIAS reverse from
// observationDescribe.js). trainStations.json keys lines by short code, so we
// translate before looking up stations.
const LONG_TO_SHORT = {
  brown: 'brn',
  green: 'g',
  orange: 'org',
  purple: 'p',
  yellow: 'y',
  red: 'red',
  blue: 'blue',
  pink: 'pink',
};

// Per-line terminus per direction for round-trip lines. Inbound for brn/org/
// pink is just "the Loop" — they round-trip there. Purple inbound is Howard
// during normal hours; the express service that runs to the Loop produces a
// distinct direction key path that round-trips through the Loop too, so
// "toward Howard" is the right label for the inbound key seen on the
// non-express branch.
const ROUND_TRIP_TERMINUS = {
  brown: { outbound: 'Kimball', inbound: 'the Loop' },
  orange: { outbound: 'Midway', inbound: 'the Loop' },
  pink: { outbound: '54th/Cermak', inbound: 'the Loop' },
  purple: { outbound: 'Linden', inbound: 'Howard' },
};

// Find the on-line station closest to (lat, lon). Used to translate the
// endpoint coords encoded in a `branch-len…` key back into a station name.
// The endpoint is the literal last polyline point of the branch in
// trainLines.json, which is always within a few hundred feet of the
// terminus station — nearest-neighbor is sufficient and avoids re-deriving
// branch geometry here.
function nearestStationName(line, lat, lon) {
  const shortCode = LONG_TO_SHORT[line] || line;
  let best = null;
  let bestD = Infinity;
  for (const s of trainStations) {
    if (!s.lines?.includes(shortCode)) continue;
    const dLat = s.lat - lat;
    const dLon = s.lon - lon;
    const d2 = dLat * dLat + dLon * dLon;
    if (d2 < bestD) {
      bestD = d2;
      best = s;
    }
  }
  return best?.name ?? null;
}

function directionLabel(line, direction) {
  if (!line || !direction || direction === 'all') return null;

  const rt = direction.match(/^branch-\d+-(outbound|inbound)$/);
  if (rt) {
    const map = ROUND_TRIP_TERMINUS[line];
    const terminus = map?.[rt[1]];
    return terminus ? `toward ${terminus}` : null;
  }

  // `branch-len{k}-{latK}-{lonK}` where latK/lonK = Math.round(coord * 1000).
  // Numbers can be negative (longitude in Chicago is around -87.6 → -87606).
  const mlen = direction.match(/^branch-len\d+-(-?\d+)-(-?\d+)$/);
  if (mlen) {
    const lat = Number(mlen[1]) / 1000;
    const lon = Number(mlen[2]) / 1000;
    const name = nearestStationName(line, lat, lon);
    return name ? `toward ${name}` : null;
  }

  return null;
}

module.exports = { directionLabel };
