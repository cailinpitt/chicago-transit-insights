const { names: routeNames } = require('./routes');
const { formatCallouts } = require('../shared/history');
const { formatMinutes, elapsedMinutesLabel, formatDistance } = require('../shared/format');

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
  // Name the empty stretch as a range between the stops flanking it. A long gap
  // can span several stops, so "near <stop>" both under-states the hole and
  // disagrees with the map. Fall back to the single anchor stop when a flank is
  // missing (e.g. a gap reaching toward a terminal), and to nothing otherwise.
  const before = gap.flankBefore?.stopName;
  const after = gap.flankAfter?.stopName;
  const mid = stop?.stopName;
  let whereClause = '';
  if (before && after) whereClause = ` between ${before} and ${after}`;
  else if (before || after) whereClause = ` past ${before || after}`;
  else if (mid) whereClause = ` near ${mid}`;
  // Frame the number as a gap *between buses*, not "no bus for ~N min" — that
  // older phrasing read as "N minutes since a bus was here," but the span
  // measures the distance between the two buses bracketing the stretch. Tilde:
  // a distance/speed estimate, not a measured ETA.
  const base = `🕳️ ${routeTitle(gap.route)} — ${pattern.direction}\n\nNo buses${whereClause} — a ~${formatMinutes(gap.gapMin)} gap, scheduled around every ${formatMinutes(gap.expectedMin)} this hour${busesLine}`;
  const tail = formatCallouts(callouts);
  return tail ? `${base}\n\n${tail}` : base;
}

function buildAltText(gap, pattern, stop) {
  const before = gap.flankBefore?.stopName;
  const after = gap.flankAfter?.stopName;
  const mid = stop?.stopName;
  let whereClause = ' between buses';
  if (before && after) whereClause = ` with no buses between ${before} and ${after}`;
  else if (mid) whereClause = ` between buses near ${mid}`;
  return `Map of ${routeTitle(gap.route)} ${pattern.direction.toLowerCase()} showing a ${formatMinutes(gap.gapMin)} gap${whereClause}.`;
}

// Timelapse reply text. The clip is framed at the gap *midpoint* (videoStop, in
// bin/bus/gaps.js — its name rides on `result.stopName`), and the trailing
// ("Next up") bus is filmed closing on it — so the reply names that midpoint
// stop and flags it as "the middle of the gap" to explain why the bus still has
// distance to cover (it's only crossing the back half). Tying the vehicle id to
// the still post's "Next up: #N" line keeps the thread coherent. Progress is the
// concrete remaining distance, not a vague bucket.
function buildGapVideoPostText(gap, result) {
  const station = result.stopName;
  const run = gap.trailing?.vid ? ` (#${gap.trailing.vid})` : '';
  const elapsed = elapsedMinutesLabel(result.elapsedSec);
  const lead = `~${result.gapMin} min ${routeTitle(gap.route)} gap.`;
  if (result.reached) {
    const where = station ? `${station} — the middle of the gap —` : 'the middle of the gap';
    return `${lead} The next bus${run} reached ${where} ${elapsed} later.`;
  }
  const remaining = formatDistance(Math.max(0, result.endDistFt || 0));
  const where = station ? `${station} — the middle of the gap` : 'the middle of the gap';
  return `${lead} ${elapsed} later, the next bus${run} had closed to within ~${remaining} of ${where}.`;
}

function buildGapVideoAltText(gap, pattern, result) {
  const stop = result.stopName;
  const where = stop ? `${stop}, the middle of the gap,` : 'the middle of the gap';
  return `Timelapse map of ${routeTitle(gap.route)} ${pattern.direction.toLowerCase()}: the next bus closing on ${where} over ${formatMinutes(result.elapsedSec / 60)}.`;
}

module.exports = { buildPostText, buildAltText, buildGapVideoPostText, buildGapVideoAltText };
