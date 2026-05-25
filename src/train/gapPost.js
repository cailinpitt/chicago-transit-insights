const { LINE_NAMES, shortStationName } = require('./api');
const { formatCallouts } = require('../shared/history');
const { formatMinutes } = require('../shared/format');

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
  // Tilde on the modeled gap: it's a distance/speed estimate, not a measured
  // ETA (see docs/GAPS.md). The schedule headway stays bare — it's a lookup.
  const base = `🕳️ ${lineName} Line — to ${dest}\n\n~${formatMinutes(gap.gapMin)} gap${whereClause} — currently scheduled every ${formatMinutes(gap.expectedMin)}${runsLine}`;
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

module.exports = { buildPostText, buildAltText };
