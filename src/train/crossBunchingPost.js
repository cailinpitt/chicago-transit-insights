// Post text for a cross-line train pileup (2+ lines stacked at one spot, e.g.
// the shared Loop track). Headline is a PLACE; trains are grouped by line with
// the disc number each carries on the map.
const { LINE_NAMES } = require('./api');
const { groupByLine } = require('./crossBunching');
const { formatCallouts } = require('../shared/history');
const { formatDistance, keycapNumber } = require('../shared/format');

function lineLabel(line) {
  return `${LINE_NAMES[line] || line} Line`;
}

// `ctx` = { placeName }. Returns the primary post text.
function buildPostText(cluster, ctx, callouts = []) {
  const { placeName } = ctx;
  const { byLine } = groupByLine(cluster);
  const where = placeName ? ` at ${placeName}` : '';
  const head = `🚆 ${cluster.trains.length} trains from ${byLine.length} lines stacked up${where}`;
  const lines = byLine
    .map((g) => {
      const list = g.rns.map((x) => `#${x.rn} (${keycapNumber(x.n)})`).join(', ');
      return `${lineLabel(g.line)}: ${list}`;
    })
    .join('\n');
  const base = `${head}\n\n${lines}`;
  const tail = formatCallouts(callouts);
  return tail ? `${base}\n\n${tail}` : base;
}

function buildAltText(cluster, ctx) {
  const { placeName } = ctx;
  const where = placeName ? ` at ${placeName}` : '';
  const lines = cluster.lines.map((l) => lineLabel(l)).join(', ');
  return `Map${where} showing ${cluster.trains.length} trains from ${cluster.lineCount} lines (${lines}) bunched within ${formatDistance(cluster.spanFt)} of each other.`;
}

module.exports = { buildPostText, buildAltText, lineLabel };
