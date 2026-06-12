const sharp = require('sharp');
const { encode } = require('../../shared/polyline');
const { offsetPolyline } = require('../../train/speedmap');
const {
  STYLE,
  WIDTH,
  HEIGHT,
  ROUTE_HALO_COLOR,
  SPEEDMAP_HALO_STROKE,
  sliceIntoSegments,
  requireMapboxToken,
  fetchMapboxStatic,
} = require('../common');

// Perpendicular offset per direction ribbon. Metra maps cover 35-60 mile
// corridors, so the CTA train offset collapses to a couple pixels and the later
// direction hides the earlier one. Keep the ribbons separated by about their
// full stroke width at commuter-rail zoom.
const DUAL_DIR_OFFSET_FT = 750;
const METRA_SPEEDMAP_SEGMENT_STROKE = 7;

// Metra color ramp: the same five buckets as the L speedmap, shifted up to
// commuter-rail speeds (matches METRA_THRESHOLDS in src/metra/speedmap.js). Red =
// crawling (approaching a terminal / congested), green = track speed. Reusing the
// CTA colorForTrainSpeed (15/25/35/45) would paint nearly every Metra segment
// green, so this is the one render-side Metra-specific piece.
function colorForMetraSpeed(mph) {
  if (mph == null) return '444'; // no data — dim gray
  if (mph < 25) return 'ff2a2a'; // red
  if (mph < 40) return 'ff8c1a'; // orange
  if (mph < 55) return 'ffd21a'; // yellow
  if (mph < 70) return 'a855f7'; // purple
  return '2ad17f'; // green
}

// Display-only fill for systematically-null end bins (position lag at terminals),
// mirroring speedForTrainRender — fall back to the nearest interior bin so the
// ribbon doesn't have a grey notch at each end. Interior nulls stay honest.
function speedForRender(binSpeeds, idx) {
  if (binSpeeds[idx] != null) return binSpeeds[idx];
  const last = binSpeeds.length - 1;
  if (idx === 0) {
    for (let i = 1; i <= last; i++) if (binSpeeds[i] != null) return binSpeeds[i];
  } else if (idx === last) {
    for (let i = last - 1; i >= 0; i--) if (binSpeeds[i] != null) return binSpeeds[i];
  }
  return null;
}

function directionOffsetFt(dirCount, index) {
  if (dirCount <= 1) return 0;
  return index === 0 ? DUAL_DIR_OFFSET_FT : -DUAL_DIR_OFFSET_FT;
}

// Render a Metra line speedmap. `branches` is `[{ points, cumDist,
// binSpeedsByDir }]` — same contract as renderTrainSpeedmap, so the geometry +
// binning pipeline is fully shared; only the color ramp differs.
async function renderMetraSpeedmap(branches) {
  const overlays = [];
  for (const branch of branches) {
    const { points, cumDist, binSpeedsByDir } = branch;
    overlays.push(
      `path-${SPEEDMAP_HALO_STROKE}+${ROUTE_HALO_COLOR}(${encodeURIComponent(encode(points))})`,
    );
    const dirs = Object.keys(binSpeedsByDir);
    dirs.forEach((dir, i) => {
      const binSpeeds = binSpeedsByDir[dir];
      const offsetFt = directionOffsetFt(dirs.length, i);
      const ribbonPairs = offsetFt === 0 ? points : offsetPolyline(points, offsetFt);
      const ribbonObjs = ribbonPairs.map(([lat, lon]) => ({ lat, lon }));
      const slices = sliceIntoSegments(ribbonObjs, cumDist, binSpeeds.length);
      for (let b = 0; b < slices.length; b++) {
        if (slices[b].length < 2) continue;
        const pairSlice = slices[b].map((p) => [p.lat, p.lon]);
        const encoded = encodeURIComponent(encode(pairSlice));
        const color = colorForMetraSpeed(speedForRender(binSpeeds, b));
        overlays.push(`path-${METRA_SPEEDMAP_SEGMENT_STROKE}+${color}(${encoded})`);
      }
    });
  }
  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/auto/${WIDTH}x${HEIGHT}@2x?access_token=${token}&padding=60`;
  const data = await fetchMapboxStatic(url);
  return sharp(data).jpeg({ quality: 85 }).toBuffer();
}

module.exports = {
  renderMetraSpeedmap,
  colorForMetraSpeed,
  directionOffsetFt,
  DUAL_DIR_OFFSET_FT,
  METRA_SPEEDMAP_SEGMENT_STROKE,
};
