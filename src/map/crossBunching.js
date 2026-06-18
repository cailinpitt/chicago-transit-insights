// Cross-route bunching map — a pileup involving multiple routes/lines at one
// spot. Unlike the per-route bunching map (which traces one pattern's polyline
// with origin/dest glyphs), this is an intersection view centered on the
// cluster centroid: each vehicle is a numbered disc colored by its route, with
// a legend mapping color → route. Generic over bus and train; the caller passes
// already-normalized points + legend, so this module knows nothing about either.
const sharp = require('sharp');
const { fitZoom, project } = require('../shared/projection');
const {
  STYLE,
  WIDTH,
  HEIGHT,
  requireMapboxToken,
  fetchMapboxStatic,
  separateMarkers,
  xmlEscape,
} = require('./common');

// Distinct, high-contrast marker colors assigned per route group (index 0..n).
const PALETTE = ['ff2a6d', '27c4f5', 'a162e8', 'ffd166', '06d6a0', 'f78c6b', 'ff8c42', 'c0c0c0'];
const MARKER_RADIUS = 30;

function colorForIndex(i) {
  return PALETTE[i % PALETTE.length];
}

// `points`: [{ lat, lon, label, groupIndex }] — one per vehicle, label = disc
// number, groupIndex = which route group (drives color). `legend`:
// [{ label, groupIndex }]. Returns a JPEG buffer. Throws (caller posts
// text-only) on <2 points or a missing Mapbox token.
async function renderCrossBunchingMap({ points, legend = [], title = '' }) {
  if (!points || points.length < 2) throw new Error('cross-bunching map needs ≥2 points');
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const bbox = {
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
    minLon: Math.min(...lons),
    maxLon: Math.max(...lons),
  };
  // Pad so a tight pileup isn't max-zoomed into a blank patch of map.
  const padLat = Math.max((bbox.maxLat - bbox.minLat) * 0.6, 0.0025);
  const padLon = Math.max((bbox.maxLon - bbox.minLon) * 0.6, 0.0025);
  const padded = {
    minLat: bbox.minLat - padLat,
    maxLat: bbox.maxLat + padLat,
    minLon: bbox.minLon - padLon,
    maxLon: bbox.maxLon + padLon,
  };
  const centerLat = (padded.minLat + padded.maxLat) / 2;
  const centerLon = (padded.minLon + padded.maxLon) / 2;
  const zoom = Math.max(12, Math.min(17, Math.floor(fitZoom(padded, WIDTH, HEIGHT, 90))));

  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${centerLon.toFixed(5)},${centerLat.toFixed(5)},${zoom.toFixed(2)}/${WIDTH}x${HEIGHT}@2x?access_token=${token}`;
  const baseMap = await fetchMapboxStatic(url, 20000);

  // Project then nudge apart radially so overlapping discs stay legible.
  const raw = points.map((p) => project(p.lat, p.lon, centerLat, centerLon, zoom, WIDTH, HEIGHT));
  const sep = separateMarkers(raw, MARKER_RADIUS * 2 + 6);
  const discs = points.map((p, i) => {
    const { x, y } = sep[i];
    const color = `#${colorForIndex(p.groupIndex)}`;
    const fontSize = MARKER_RADIUS * 1.2;
    return (
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${MARKER_RADIUS}" fill="${color}" stroke="#fff" stroke-width="3"/>` +
      `<text x="${x.toFixed(1)}" y="${(y + fontSize * 0.35).toFixed(1)}" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#1c1c1c">${xmlEscape(p.label)}</text>`
    );
  });

  // Legend bottom-left: color swatch + route label per group.
  const legendEls = [];
  if (legend.length) {
    const rowH = 40;
    const boxW = 320;
    const boxH = legend.length * rowH + 16;
    const x0 = 24;
    const y0 = HEIGHT - boxH - 24;
    legendEls.push(
      `<rect x="${x0}" y="${y0}" width="${boxW}" height="${boxH}" rx="8" fill="#000" fill-opacity="0.7"/>`,
    );
    legend.forEach((g, i) => {
      const cy = y0 + 16 + i * rowH + rowH / 2 - 8;
      const color = `#${colorForIndex(g.groupIndex)}`;
      legendEls.push(
        `<circle cx="${x0 + 26}" cy="${cy}" r="14" fill="${color}" stroke="#fff" stroke-width="2"/>`,
        `<text x="${x0 + 52}" y="${cy + 9}" fill="#fff" font-family="Inter, Helvetica, Arial, sans-serif" font-size="26" font-weight="600">${xmlEscape(g.label)}</text>`,
      );
    });
  }

  // Title pill top-center.
  const titleEls = [];
  if (title) {
    const pillH = 56;
    const pillW = Math.min(WIDTH - 80, title.length * 20 + 48);
    const x0 = (WIDTH - pillW) / 2;
    titleEls.push(
      `<rect x="${x0}" y="24" width="${pillW}" height="${pillH}" rx="10" fill="#000" fill-opacity="0.72"/>`,
      `<text x="${WIDTH / 2}" y="${24 + pillH / 2 + 11}" text-anchor="middle" fill="#fff" font-family="Inter, Helvetica, Arial, sans-serif" font-size="32" font-weight="700">${xmlEscape(title)}</text>`,
    );
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${titleEls.join('')}${legendEls.join('')}${discs.join('')}</svg>`;
  return sharp(baseMap)
    .resize(WIDTH, HEIGHT)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

// Build the normalized { points, legend } the renderer wants from a cluster's
// vehicles/trains. `items` are the cluster members; `idOf`/`groupKeyOf` read an
// item's id and its route/line; `labels` is the Map(id→discNumber) from
// groupByRoute/groupByLine; `groupOrder` is the ordered list of route/line keys
// (so legend + color indices match the post text); `legendLabelOf` renders a
// group key to its display label.
function pointsFromCluster(items, { idOf, groupKeyOf, labels, groupOrder, legendLabelOf }) {
  const groupIndex = new Map(groupOrder.map((k, i) => [k, i]));
  const points = items.map((it) => ({
    lat: it.lat,
    lon: it.lon,
    label: String(labels.get(idOf(it)) ?? '?'),
    groupIndex: groupIndex.get(groupKeyOf(it)) ?? 0,
  }));
  const legend = groupOrder.map((k, i) => ({ label: legendLabelOf(k), groupIndex: i }));
  return { points, legend };
}

module.exports = { renderCrossBunchingMap, pointsFromCluster, PALETTE };
