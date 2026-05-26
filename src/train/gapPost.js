const { LINE_NAMES, shortStationName } = require('./api');
const { formatCallouts } = require('../shared/history');
const { formatMinutes, elapsedMinutesLabel } = require('../shared/format');

function buildPostText(gap, callouts = []) {
  const lineName = LINE_NAMES[gap.line];
  const dest = gap.leading.destination;
  const where = shortStationName(gap.nearStation?.name || gap.leading.nextStation);
  const whereClause = where ? ` near ${where}` : '';
  // `leading` is the train already past the gap (last seen); `trailing` is the
  // next one a rider is waiting for. "(last)/(next)" read as ambiguous ("last
  // train" = final train of the night), so spell the rider roles out — the map
  // tags the two discs L/N to match.
  const lastSeen = gap.leading?.rn ? `#${gap.leading.rn}` : null;
  const nextUp = gap.trailing?.rn ? `#${gap.trailing.rn}` : null;
  const runsLine =
    lastSeen || nextUp
      ? `\n\n${[lastSeen && `Last seen: ${lastSeen}`, nextUp && `Next up: ${nextUp}`].filter(Boolean).join(' · ')}`
      : '';
  // Lead with the lived effect — "No train for ~24 min" reads as the service
  // hole a rider is sitting in, not an abstract "gap." Tilde on the modeled
  // span: it's a distance/speed estimate, not a measured ETA (see docs/GAPS.md).
  // The schedule headway stays bare — it's a lookup.
  const base = `🕳️ ${lineName} Line — to ${dest}\n\nNo train${whereClause} for ~${formatMinutes(gap.gapMin)} — currently scheduled every ${formatMinutes(gap.expectedMin)}${runsLine}`;
  const tail = formatCallouts(callouts);
  return tail ? `${base}\n\n${tail}` : base;
}

function buildAltText(gap) {
  const lineName = LINE_NAMES[gap.line];
  const dest = gap.leading.destination;
  const where = shortStationName(gap.nearStation?.name);
  const whereClause = where ? ` near ${where}` : '';
  return `Map of the ${lineName} Line toward ${dest} showing a ${formatMinutes(gap.gapMin)} gap between trains${whereClause}.`;
}

// Timelapse reply text. Anchors on the parent post's station (where the rider
// is waiting). The video itself is framed at the gap *midpoint*, but that
// station would be unfamiliar to a reader landing on the reply. Progress is
// described against the train's travel toward the midpoint (startDistFt →
// endDistFt), bucketed into words so we don't print a precise percentage of a
// half-gap.
function buildGapVideoPostText(gap, result) {
  const station = shortStationName(gap.nearStation?.name || gap.leading.nextStation);
  const where = station ? ` near ${station}` : '';
  const elapsed = elapsedMinutesLabel(result.elapsedSec);
  const lead = `~${result.gapMin} min gap on the ${LINE_NAMES[gap.line]} Line${where}.`;
  if (result.reached) {
    return `${lead} The next train closed the gap ${elapsed} later.`;
  }
  const closed = Math.max(0, (result.startDistFt || 0) - (result.endDistFt || 0));
  const fraction = result.startDistFt > 0 ? closed / result.startDistFt : 0;
  let progress;
  if (fraction < 0.25) progress = 'had barely closed in';
  else if (fraction < 0.6) progress = 'had covered about half the gap';
  else progress = 'had nearly closed the gap';
  return `${lead} ${elapsed} later, the next train ${progress}.`;
}

function buildGapVideoAltText(gap, result) {
  const lineName = LINE_NAMES[gap.line];
  const dest = gap.leading.destination;
  const stop = shortStationName(result.stopName) || 'the stop';
  return `Timelapse map of the ${lineName} Line toward ${dest} showing the next train approaching ${stop} over ${formatMinutes(result.elapsedSec / 60)}.`;
}

module.exports = { buildPostText, buildAltText, buildGapVideoPostText, buildGapVideoAltText };
