const { encode } = require('../../shared/polyline');
const { buildLinePolyline, pointAlongLine, snapToLine } = require('../../train/speedmap');
const {
  computeTrainBunchingView,
  fetchTrainBunchingBaseMap,
  renderTrainBunchingFrame,
} = require('./bunching');

// Warm amber for the gap strip — pops on the dark basemap without the neon
// magenta we used to render. Per-line override for Yellow because the route
// itself is bright yellow (f9e300) and amber would muddy against it; coral
// reads "alert" against yellow rails. No other line shares amber's hue family.
const GAP_SEGMENT_DEFAULT_COLOR = 'ffb020';
const GAP_SEGMENT_COLOR_BY_LINE = { y: 'ff4d6d' };
const GAP_SEGMENT_STROKE = 10;

function gapSegmentColor(line) {
  return GAP_SEGMENT_COLOR_BY_LINE[line] || GAP_SEGMENT_DEFAULT_COLOR;
}

/**
 * Compute a static-map view for a train gap event. Reuses the train bunching
 * framing (bbox, station picks, direction arrow) by treating the leading and
 * trailing trains as a two-train "bunch", then layers a colored highlight
 * along the polyline segment between them so the gap itself reads as the
 * focal element.
 *
 * Diverges from bunching framing in two ways:
 *   1. Strips every station pin/label except the two stations immediately
 *      flanking the gap (one just outside each train). Bunching keeps a dense
 *      pin field for context; gaps want the eye to land on the highlight.
 *   2. Uses an amber/coral highlight instead of the line color so the gap is
 *      visually distinct from the route line below it.
 */
function computeTrainGapView(gap, lineColors, trainLines, stations) {
  const bunch = { line: gap.line, trDr: gap.trDr, trains: [gap.leading, gap.trailing] };
  const view = computeTrainBunchingView(bunch, lineColors, trainLines, stations, [], {
    fitBbox: true,
  });

  const { points, cumDist } = buildLinePolyline(trainLines, gap.line);
  const lo = Math.min(gap.leadingTrackDist, gap.trailingTrackDist);
  const hi = Math.max(gap.leadingTrackDist, gap.trailingTrackDist);

  // Drop every pin overlay the bunching framing added — we'll add back only
  // the flank pair below. Line-segment paths (path-7+...) are kept.
  view.overlays = view.overlays.filter((o) => !o.startsWith('pin-'));

  // Find the station immediately outside each end of the gap. These act as
  // verbal anchors so a reader can name where the gap starts and ends.
  const onLineStations = (stations || []).filter((s) => s.lines?.includes(gap.line));
  const stationsWithDist = onLineStations.map((s) => ({
    station: s,
    trackDist: snapToLine(s.lat, s.lon, points, cumDist),
  }));
  const justOutsideLo = stationsWithDist
    .filter((s) => s.trackDist < lo)
    .sort((a, b) => b.trackDist - a.trackDist)[0];
  const justOutsideHi = stationsWithDist
    .filter((s) => s.trackDist > hi)
    .sort((a, b) => a.trackDist - b.trackDist)[0];
  const flank = [justOutsideLo, justOutsideHi].filter(Boolean).map((s) => s.station);
  const flankNames = new Set(flank.map((s) => s.name));

  for (const s of flank) {
    view.overlays.push(`pin-s+ffffff(${s.lon.toFixed(5)},${s.lat.toFixed(5)})`);
  }
  view.visibleStations = view.visibleStations.filter((v) => flankNames.has(v.station.name));
  view.pinStations = view.pinStations.filter((p) => flankNames.has(p.station.name));

  // Anchor the strip at the trains' actual snapped positions, not at whichever
  // polyline vertex happens to fall just inside [lo, hi]. Train polylines have
  // sparse vertices, so vertex-only filtering visibly ends the strip short of
  // the train pin (e.g. terminating at Sheridan when the trailing train is at
  // Fullerton).
  const loPt = pointAlongLine(points, cumDist, lo);
  const hiPt = pointAlongLine(points, cumDist, hi);
  const gapPts = [];
  if (loPt) gapPts.push([loPt.lat, loPt.lon]);
  for (let i = 0; i < points.length; i++) {
    if (cumDist[i] > lo && cumDist[i] < hi) gapPts.push(points[i]);
  }
  if (hiPt) gapPts.push([hiPt.lat, hiPt.lon]);
  if (gapPts.length >= 2) {
    // Splice the gap overlay between the line-segment paths and the (now
    // flank-only) station pins so station markers still sit on top.
    const firstPinIdx = view.overlays.findIndex((o) => o.startsWith('pin-'));
    const insertAt = firstPinIdx === -1 ? view.overlays.length : firstPinIdx;
    const overlay = `path-${GAP_SEGMENT_STROKE}+${gapSegmentColor(gap.line)}(${encodeURIComponent(encode(gapPts))})`;
    view.overlays.splice(insertAt, 0, overlay);
  }
  return view;
}

async function renderTrainGap(gap, lineColors, trainLines, stations) {
  const view = computeTrainGapView(gap, lineColors, trainLines, stations);
  const baseMap = await fetchTrainBunchingBaseMap(view);
  // Tag the two discs L (last seen) / N (next up) so the post's "Last seen" /
  // "Next up" run numbers map onto the pins. Chips are keyed by `rn`.
  const labels = new Map();
  if (gap.leading?.rn != null) labels.set(gap.leading.rn, 'L');
  if (gap.trailing?.rn != null) labels.set(gap.trailing.rn, 'N');
  return renderTrainBunchingFrame(view, baseMap, [gap.leading, gap.trailing], { labels });
}

module.exports = { renderTrainGap, computeTrainGapView };
