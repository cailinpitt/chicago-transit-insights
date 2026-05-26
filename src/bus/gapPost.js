const { names: routeNames } = require('./routes');
const { formatCallouts } = require('../shared/history');
const { formatMinutes, elapsedMinutesLabel } = require('../shared/format');

function routeTitle(route) {
  const name = routeNames[route];
  return name ? `Route ${route} (${name})` : `Route ${route}`;
}

function buildPostText(gap, pattern, stop, callouts = []) {
  // `leading` is the bus already past the gap (last seen); `trailing` is the
  // next one a rider is waiting for. "(last)/(next)" read as ambiguous, so spell
  // the rider roles out — the map tags the two discs L/N to match.
  const lastSeen = gap.leading?.vid ? `#${gap.leading.vid}` : null;
  const nextUp = gap.trailing?.vid ? `#${gap.trailing.vid}` : null;
  const busesLine =
    lastSeen || nextUp
      ? `\n\n${[lastSeen && `Last seen: ${lastSeen}`, nextUp && `Next up: ${nextUp}`].filter(Boolean).join(' · ')}`
      : '';
  // Lead with the lived effect — "No bus for ~24 min" reads as the service hole
  // a rider is sitting in, not an abstract "gap." Tilde: it's a distance/speed
  // estimate, not a measured ETA.
  const base = `🕳️ ${routeTitle(gap.route)} — ${pattern.direction}\n\nNo bus near ${stop.stopName} for ~${formatMinutes(gap.gapMin)} — scheduled around every ${formatMinutes(gap.expectedMin)} this hour${busesLine}`;
  const tail = formatCallouts(callouts);
  return tail ? `${base}\n\n${tail}` : base;
}

function buildAltText(gap, pattern, stop) {
  return `Map of ${routeTitle(gap.route)} ${pattern.direction.toLowerCase()} showing a ${formatMinutes(gap.gapMin)} gap between buses near ${stop.stopName}.`;
}

// Timelapse reply text. Anchors on the parent post's stop (where the rider is
// waiting) — the video itself is framed at the gap *midpoint*, but that stop
// would be unfamiliar to a reader landing on the reply. Progress is described
// against the bus's travel toward the midpoint (startDistFt → endDistFt),
// bucketed into words so we don't print a precise percentage of a half-gap.
function buildGapVideoPostText(gap, result, stop) {
  const where = stop?.stopName ? ` near ${stop.stopName}` : '';
  const elapsed = elapsedMinutesLabel(result.elapsedSec);
  const lead = `~${result.gapMin} min gap on ${routeTitle(gap.route)}${where}.`;
  if (result.reached) {
    return `${lead} The next bus closed the gap ${elapsed} later.`;
  }
  const closed = Math.max(0, (result.startDistFt || 0) - (result.endDistFt || 0));
  const fraction = result.startDistFt > 0 ? closed / result.startDistFt : 0;
  let progress;
  if (fraction < 0.25) progress = 'had barely closed in';
  else if (fraction < 0.6) progress = 'had covered about half the gap';
  else progress = 'had nearly closed the gap';
  return `${lead} ${elapsed} later, the next bus ${progress}.`;
}

function buildGapVideoAltText(gap, pattern, result) {
  const stop = result.stopName || 'the stop';
  return `Timelapse map of ${routeTitle(gap.route)} ${pattern.direction.toLowerCase()} showing the next bus approaching ${stop} over ${formatMinutes(result.elapsedSec / 60)}.`;
}

module.exports = { buildPostText, buildAltText, buildGapVideoPostText, buildGapVideoAltText };
