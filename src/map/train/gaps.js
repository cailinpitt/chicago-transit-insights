const { encode } = require('../../shared/polyline');
const { buildLinePolyline, pointAlongLine, snapToLine } = require('../../train/speedmap');
const { project } = require('../../shared/projection');
const { WIDTH, HEIGHT } = require('../common');
const {
  computeTrainBunchingView,
  fetchTrainBunchingBaseMap,
  renderTrainBunchingFrame,
} = require('./bunching');

/**
 * Compute a static-map view for a train gap event. Reuses the train bunching
 * framing (bbox, station picks, direction arrow) by treating the leading and
 * trailing trains as a two-train "bunch", then exposes the polyline segment
 * between them as `gapPath` so the frame renderer can dash it over the route.
 *
 * Diverges from bunching framing in two ways:
 *   1. Strips every station pin/label except the two stations immediately
 *      flanking the gap (one just outside each train). Bunching keeps a dense
 *      pin field for context; gaps want the eye to land on the gap stretch.
 *   2. Renders the gap stretch as a dashed line in the line's own color (drawn
 *      in the SVG layer by renderTrainBunchingFrame) instead of a solid
 *      highlight hue, so it reads as a break in the route rather than a stripe.
 */
function computeTrainGapView(gap, lineColors, trainLines, stations) {
  const bunch = { line: gap.line, trDr: gap.trDr, trains: [gap.leading, gap.trailing] };
  const view = computeTrainBunchingView(bunch, lineColors, trainLines, stations, [], {
    fitBbox: true,
  });

  const { points, cumDist } = buildLinePolyline(trainLines, gap.line);
  const lo = Math.min(gap.leadingTrackDist, gap.trailingTrackDist);
  const hi = Math.max(gap.leadingTrackDist, gap.trailingTrackDist);

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
  view.visibleStations = view.visibleStations.filter((v) => flankNames.has(v.station.name));
  view.pinStations = view.pinStations.filter((p) => flankNames.has(p.station.name));

  // Anchor the boundary at the trains' actual snapped positions, not at whichever
  // polyline vertex happens to fall just inside [lo, hi]. Train polylines have
  // sparse vertices, so vertex-only filtering visibly ends the line short of the
  // train pin (e.g. terminating at Sheridan when the trailing train is at
  // Fullerton).
  const loPt = pointAlongLine(points, cumDist, lo);
  const hiPt = pointAlongLine(points, cumDist, hi);
  const gapPts = [];
  if (loPt) gapPts.push([loPt.lat, loPt.lon]);
  for (let i = 0; i < points.length; i++) {
    if (cumDist[i] > lo && cumDist[i] < hi) gapPts.push(points[i]);
  }
  if (hiPt) gapPts.push([hiPt.lat, hiPt.lon]);

  // Rebuild the route so it runs solid only *outside* the gap. The gap stretch
  // is dashed in the line color by the frame renderer (Mapbox static paths can't
  // dash); leaving the solid line baked underneath would show between the dashes.
  // Build the two solid slices from the dense polyline with interpolated boundary
  // points so a sparse raw segment can't bridge the gap.
  const beforePts = points.filter((_, i) => cumDist[i] <= lo);
  if (loPt) beforePts.push([loPt.lat, loPt.lon]);
  const afterPts = [];
  if (hiPt) afterPts.push([hiPt.lat, hiPt.lon]);
  for (let i = 0; i < points.length; i++) if (cumDist[i] >= hi) afterPts.push(points[i]);
  const routeOverlay = (pts) =>
    pts.length >= 2 ? `path-7+${view.color}-0.7(${encodeURIComponent(encode(pts))})` : null;
  view.overlays = view.overlays.filter((o) => !o.startsWith('path-') && !o.startsWith('pin-'));
  view.overlays.unshift(...[routeOverlay(beforePts), routeOverlay(afterPts)].filter(Boolean));
  for (const s of flank) {
    view.overlays.push(`pin-s+ffffff(${s.lon.toFixed(5)},${s.lat.toFixed(5)})`);
  }

  // Hand the gap polyline to the frame renderer to dash in the SVG layer.
  view.gapPath = gapPts.map(([lat, lon]) => ({ lat, lon }));
  return view;
}

/**
 * Framing for a gap *timelapse* — different from the still gap view. The clip
 * follows only the trailing ("Next up") train approaching the wait stop; the
 * leading train is dropped entirely (it already left, and on bad gaps it sits
 * near a terminal, which would force the bbox miles wide). The frame fits the
 * trailing train's whole captured path plus the wait stop, so the camera holds
 * still while the train advances across it. `trailingPath` is every captured
 * position of the trailing train (widens the bbox so later frames stay in view).
 */
function computeTrainGapVideoView(gap, trailingPath, lineColors, trainLines, stations) {
  const bunch = { line: gap.line, trDr: gap.trDr, trains: [gap.trailing] };
  const stop = gap.nearStation;
  // extraTrains only widen the bbox (they aren't rendered) — feed the trailing
  // train's path and a pseudo-point at the wait stop so both stay framed.
  const extra = [...trailingPath];
  if (stop?.lat != null && stop?.lon != null) extra.push({ lat: stop.lat, lon: stop.lon });
  const view = computeTrainBunchingView(bunch, lineColors, trainLines, stations, extra, {
    fitBbox: true,
  });

  // Guarantee the wait stop is pinned + labeled (it's the clip's anchor). The
  // bunching framing labels stations flanking the trailing train, which may not
  // reach the stop ahead of it.
  if (stop?.lat != null && stop?.lon != null) {
    const already = view.visibleStations.some((v) => v.station.name === stop.name);
    if (!already) {
      view.overlays.push(`pin-s+ffffff(${stop.lon.toFixed(5)},${stop.lat.toFixed(5)})`);
      const px = project(
        stop.lat,
        stop.lon,
        view.centerLat,
        view.centerLon,
        view.zoom,
        WIDTH,
        HEIGHT,
      );
      view.visibleStations.push({ station: stop, x: px.x, y: px.y, bearingDeg: view.bearingDeg });
      view.pinStations.push({ station: stop, x: px.x, y: px.y });
    }
  }

  // Dash the gap stretch the next train still has to cover — from its starting
  // position up to the midpoint wait stop — in the line color, matching the
  // still gap map. The bunching framing bakes the full solid route; rebuild it
  // to run solid only outside [lo, hi] so the dashes (drawn by the frame
  // renderer) show on bare basemap. Static for the whole clip (the train drives
  // across it); the base map is fetched once so the stretch can't follow it.
  const { points, cumDist } = buildLinePolyline(trainLines, gap.line);
  const startPt = trailingPath?.[0];
  if (points.length >= 2 && startPt && stop?.lat != null && stop?.lon != null) {
    const lo = snapToLine(startPt.lat, startPt.lon, points, cumDist);
    const hi = snapToLine(stop.lat, stop.lon, points, cumDist);
    if (hi > lo) {
      const loPt = pointAlongLine(points, cumDist, lo);
      const hiPt = pointAlongLine(points, cumDist, hi);
      const gapPts = [];
      if (loPt) gapPts.push([loPt.lat, loPt.lon]);
      for (let i = 0; i < points.length; i++) {
        if (cumDist[i] > lo && cumDist[i] < hi) gapPts.push(points[i]);
      }
      if (hiPt) gapPts.push([hiPt.lat, hiPt.lon]);

      const beforePts = points.filter((_, i) => cumDist[i] <= lo);
      if (loPt) beforePts.push([loPt.lat, loPt.lon]);
      const afterPts = [];
      if (hiPt) afterPts.push([hiPt.lat, hiPt.lon]);
      for (let i = 0; i < points.length; i++) if (cumDist[i] >= hi) afterPts.push(points[i]);
      const routeOverlay = (pts) =>
        pts.length >= 2 ? `path-7+${view.color}-0.7(${encodeURIComponent(encode(pts))})` : null;
      view.overlays = view.overlays.filter((o) => !o.startsWith('path-'));
      view.overlays.unshift(...[routeOverlay(beforePts), routeOverlay(afterPts)].filter(Boolean));

      if (gapPts.length >= 2) {
        view.gapPath = gapPts.map(([lat, lon]) => ({ lat, lon }));
        // Station pins are normally baked into the base map, which would put
        // them *under* the dashed gap. Strip them and let the frame renderer
        // draw the pins in the SVG layer above the dash instead.
        view.overlays = view.overlays.filter((o) => !o.startsWith('pin-'));
        view.drawPinsInSvg = true;
      }
    }
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

module.exports = { renderTrainGap, computeTrainGapView, computeTrainGapVideoView };
