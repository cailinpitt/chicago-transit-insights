const sharp = require('sharp');
const { encode } = require('../../shared/polyline');
const { cumulativeDistances, haversineFt, bearing } = require('../../shared/geo');
const { fitZoom, project } = require('../../shared/projection');
const {
  STYLE,
  WIDTH,
  HEIGHT,
  ROUTE_HALO_COLOR,
  ROUTE_HALO_STROKE,
  ROUTE_CORE_COLOR,
  ROUTE_CORE_STROKE,
  TWEMOJI_HOUSE_INNER,
  TWEMOJI_FLAG_INNER,
  buildBusMarker,
  buildTerminalMarker,
  buildDirectionArrow,
  markerLabelChip,
  buildStopMarker,
  xmlEscape,
  measureTextWidth,
  perpendicularFromBearing,
  requireMapboxToken,
  fetchMapboxStatic,
} = require('../common');
const { isArticulated } = require('../../bus/fleet');

// Warm amber for the segment *between* the two bounding buses — that's the
// stretch of route where a rider would be waiting. Matches the train gap strip
// (src/map/train/gaps.js) so both modes' gap maps read the same; pops on the
// dark basemap without the neon magenta we used to render.
const GAP_SEGMENT_COLOR = 'ffb020';
const GAP_SEGMENT_STROKE = 10;
const BUS_COLOR = 'ff2a6d';
const BUS_MARKER_RADIUS = 34;
const TERMINAL_MARKER_RADIUS = BUS_MARKER_RADIUS;
const CONTEXT_PAD_FT = 1500;

// Walk the pattern in seq order, building cumulative distance, then return
// the ordered sub-polyline between the two buses' nearest-vertex positions.
// Same strategy as slicePatternAroundBunch — pattern.pdist can't be trusted
// for waypoints so we match by haversine distance.
function sliceBetweenVehicles(pattern, a, b) {
  const cum = cumulativeDistances(pattern.points);
  function nearestCum(v) {
    let bestIdx = 0;
    let bestDist = haversineFt(v, pattern.points[0]);
    for (let i = 1; i < pattern.points.length; i++) {
      const d = haversineFt(v, pattern.points[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return { idx: bestIdx, cum: cum[bestIdx] };
  }
  const A = nearestCum(a);
  const B = nearestCum(b);
  const lo = Math.min(A.cum, B.cum);
  const hi = Math.max(A.cum, B.cum);
  const inner = pattern.points.filter((_, i) => cum[i] >= lo && cum[i] <= hi);
  const padLo = lo - CONTEXT_PAD_FT;
  const padHi = hi + CONTEXT_PAD_FT;
  const framing = pattern.points.filter((_, i) => cum[i] >= padLo && cum[i] <= padHi);
  return { inner, framing };
}

function computeGapView(gap, pattern) {
  const { inner, framing } = sliceBetweenVehicles(pattern, gap.leading, gap.trailing);

  const fullPoly = encode(pattern.points.map((p) => [p.lat, p.lon]));
  const gapPoly = encode(inner.map((p) => [p.lat, p.lon]));
  const overlays = [
    `path-${ROUTE_HALO_STROKE}+${ROUTE_HALO_COLOR}(${encodeURIComponent(fullPoly)})`,
    `path-${ROUTE_CORE_STROKE}+${ROUTE_CORE_COLOR}(${encodeURIComponent(fullPoly)})`,
    `path-${GAP_SEGMENT_STROKE}+${GAP_SEGMENT_COLOR}(${encodeURIComponent(gapPoly)})`,
  ];

  const framePts = framing.length > 0 ? framing : inner;
  const vehicles = [gap.leading, gap.trailing];
  // Pull the flanking stops into the bbox so both end labels stay on-frame —
  // they sit just outside each bus and can fall past the context pad otherwise.
  const flankPts = [gap.flankBefore, gap.flankAfter].filter(
    (s) => s?.lat != null && s?.lon != null,
  );
  const allLats = [
    ...framePts.map((p) => p.lat),
    ...vehicles.map((v) => v.lat),
    ...flankPts.map((s) => s.lat),
  ];
  const allLons = [
    ...framePts.map((p) => p.lon),
    ...vehicles.map((v) => v.lon),
    ...flankPts.map((s) => s.lon),
  ];
  const bbox = {
    minLat: Math.min(...allLats),
    maxLat: Math.max(...allLats),
    minLon: Math.min(...allLons),
    maxLon: Math.max(...allLons),
  };
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;
  const rawZoom = fitZoom(bbox, WIDTH, HEIGHT, 60);
  const zoom = Math.max(10, Math.min(17, Math.floor(rawZoom)));

  // Direction arrow: use the framing slice endpoints, smoothed against the
  // leading bus's reported heading (same fallback logic as bunching).
  let bearingDeg = gap.leading.heading;
  if (framePts.length >= 2) {
    const fwd = bearing(framePts[0], framePts[framePts.length - 1]);
    const rev = (fwd + 180) % 360;
    const diffFwd = Math.abs(((gap.leading.heading - fwd + 540) % 360) - 180);
    const diffRev = Math.abs(((gap.leading.heading - rev + 540) % 360) - 180);
    bearingDeg = diffFwd <= diffRev ? fwd : rev;
  }

  // Origin (first point) and destination (last point) — same semantics as bus
  // bunching. Either is rendered only if it falls in the viewport; for most
  // mid-route gaps neither will, and that's fine.
  const originPoint = pattern.points[0];
  const terminalPoint = pattern.points[pattern.points.length - 1];
  const origin = originPoint ? { lat: originPoint.lat, lon: originPoint.lon } : null;
  const terminal = terminalPoint ? { lat: terminalPoint.lat, lon: terminalPoint.lon } : null;

  return { overlays, centerLat, centerLon, zoom, bearingDeg, origin, terminal };
}

async function fetchGapBaseMap(view) {
  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${view.overlays.join(',')}/${view.centerLon.toFixed(5)},${view.centerLat.toFixed(5)},${view.zoom.toFixed(2)}/${WIDTH}x${HEIGHT}@2x?access_token=${token}`;
  return fetchMapboxStatic(url, 20000);
}

async function renderGapMap(gap, pattern, stop = null) {
  const view = computeGapView(gap, pattern);
  const baseMap = await fetchGapBaseMap(view);
  // leading = last seen (L), trailing = next up (N) — same roles as the post.
  const vehicles = [gap.leading, gap.trailing];
  const labels = ['L', 'N'];
  const vehiclePixels = vehicles.map((v) =>
    project(v.lat, v.lon, view.centerLat, view.centerLon, view.zoom, WIDTH, HEIGHT),
  );
  const markerElements = vehicles.map((v, i) =>
    buildBusMarker({
      x: vehiclePixels[i].x,
      y: vehiclePixels[i].y,
      radius: BUS_MARKER_RADIUS,
      color: BUS_COLOR,
      articulated: isArticulated(v.vid),
    }),
  );
  // Identity chips in a layer above the discs so the post's "Last seen" /
  // "Next up" rows map onto the two pins.
  const chipElements = vehicles.map((_, i) =>
    markerLabelChip(vehiclePixels[i].x, vehiclePixels[i].y, BUS_MARKER_RADIUS, labels[i]),
  );

  // Label the stops flanking the gap — one just outside each bus — so the map
  // names the same stretch the post does ("between A and B"), matching the train
  // gap map. Falls back to the single anchor stop when flanks are missing, which
  // mirrors the post's "near X" fallback. Push each sign off the route, label
  // below.
  const flankStops = [gap.flankBefore, gap.flankAfter].filter(
    (s) => s?.lat != null && s?.lon != null,
  );
  const labelStops = flankStops.length
    ? flankStops
    : stop && stop.lat != null && stop.lon != null
      ? [stop]
      : [];
  const stopElements = [];
  for (const s of labelStops) {
    const { x, y } = project(
      s.lat,
      s.lon,
      view.centerLat,
      view.centerLon,
      view.zoom,
      WIDTH,
      HEIGHT,
    );
    if (x < 0 || x > WIDTH || y < 0 || y > HEIGHT) continue;
    const perp = perpendicularFromBearing(view.bearingDeg);
    const sx = x + perp.x * 26;
    const sy = y + perp.y * 26;
    stopElements.push(buildStopMarker(sx, sy, 32));
    const rawName = s.stopName || '';
    if (!rawName) continue;
    const fontSize = 16;
    const labelH = 26;
    // Measure actual glyph width (librsvg) instead of guessing per-char — the
    // heuristic left a wide band of dead padding around shorter names.
    const textW = await measureTextWidth(rawName, fontSize, { bold: true });
    const boxW = textW + 16; // 8px padding each side
    const lx = Math.max(4, Math.min(WIDTH - boxW - 4, sx - boxW / 2));
    const ly = Math.max(4, Math.min(HEIGHT - labelH - 4, sy + 24));
    stopElements.push(
      `<rect x="${lx}" y="${ly}" width="${boxW}" height="${labelH}" fill="#000" fill-opacity="0.8" rx="3"/>`,
      `<text x="${lx + boxW / 2}" y="${ly + 18}" fill="#fff" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="600">${xmlEscape(rawName)}</text>`,
    );
  }
  const arrowElements = [buildDirectionArrow(WIDTH - 220, 180, view.bearingDeg)];

  const terminalElements = [];
  for (const [point, glyph] of [
    [view.origin, TWEMOJI_HOUSE_INNER],
    [view.terminal, TWEMOJI_FLAG_INNER],
  ]) {
    if (!point) continue;
    const { x, y } = project(
      point.lat,
      point.lon,
      view.centerLat,
      view.centerLon,
      view.zoom,
      WIDTH,
      HEIGHT,
    );
    if (x < 0 || x > WIDTH || y < 0 || y > HEIGHT) continue;
    terminalElements.push(...buildTerminalMarker(x, y, TERMINAL_MARKER_RADIUS, glyph));
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${terminalElements.join('\n')}${stopElements.join('\n')}${markerElements.join('\n')}${chipElements.join('\n')}${arrowElements.join('\n')}</svg>`;
  return sharp(baseMap)
    .resize(WIDTH, HEIGHT)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

module.exports = { renderGapMap };
