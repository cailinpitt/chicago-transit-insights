const sharp = require('sharp');
const { encode } = require('../../shared/polyline');
const { haversineFt, bearing } = require('../../shared/geo');
const { fitZoom, project } = require('../../shared/projection');
const { buildLinePolyline, snapToLine } = require('../../train/speedmap');
const { shortStationName } = require('../../train/api');
const { dayTypeFor, chicagoHour } = require('../../shared/gtfs');
const {
  STYLE,
  WIDTH,
  HEIGHT,
  TWEMOJI_TRAIN_INNER,
  buildTurnaroundMarker,
  markerLabelChip,
  buildCometTrail,
  buildClipProgress,
  buildReadoutPill,
  TWEMOJI_HOUSE_INNER,
  TWEMOJI_FLAG_INNER,
  buildTerminalMarker,
  buildDirectionArrow,
  buildGhostLegend,
  buildDashedGapSvg,
  buildStationPinDotSvg,
  xmlEscape,
  measureTextWidth,
  requireMapboxToken,
  fetchMapboxStatic,
  separateMarkers,
  perpendicularFromBearing,
} = require('../common');

const TRAIN_BUNCH_BBOX_PADDING_DEG = 0.003; // ~300m — zoom out a little past the trains

// Train pin radius. Set well above Mapbox pin-s (stations) so trains read as
// the primary focal point. Halo/arrow offsets are derived from this.
const TRAIN_MARKER_RADIUS = 32;
const TERMINAL_MARKER_RADIUS = TRAIN_MARKER_RADIUS;
// Threshold for painting the white halo on a train sitting at a station.
// Tightened to roughly one car length so the halo only appears while the
// train is actually dwelling — approaching/departing trains shed it
// immediately instead of trailing it across several frames.
const AT_STATION_FT = 120;

// True geographic terminals per line, keyed by the CTA `destNm` string. Loop
// lines (Brown/Orange/Pink/Purple) return "Loop" when heading downtown — those
// have no real end-of-line, so we omit them from the map and skip the marker.
// Yellow's "Skokie" short-name maps to the Dempster-Skokie station.
const TRUE_TERMINALS = {
  red: { Howard: 'Howard', '95th/Dan Ryan': '95th/Dan Ryan' },
  blue: { "O'Hare": "O'Hare", 'Forest Park': 'Forest Park' },
  g: {
    'Harlem/Lake': 'Harlem/Lake',
    'Ashland/63rd': 'Ashland/63rd',
    'Cottage Grove': 'Cottage Grove',
  },
  brn: { Kimball: 'Kimball' },
  org: { Midway: 'Midway' },
  p: { Linden: 'Linden', Howard: 'Howard' },
  pink: { '54th/Cermak': '54th/Cermak' },
  y: { 'Dempster-Skokie': 'Dempster-Skokie', Skokie: 'Dempster-Skokie', Howard: 'Howard' },
};

function findTerminal(bunch, stations) {
  const lineTerms = TRUE_TERMINALS[bunch.line];
  if (!lineTerms) return null;
  const dest = bunch.trains[0]?.destination;
  if (!dest) return null;
  const stationName = lineTerms[dest];
  if (!stationName) return null;
  const st = (stations || []).find((s) => s.name === stationName);
  return st ? { lat: st.lat, lon: st.lon } : null;
}

// Origin (start of trip) marker. CTA's API doesn't return origin, so for each
// line we provide a resolver that returns the implied origin station name (or
// null if it's ambiguous). Default rule for most lines: destination uniquely
// implies origin since they have exactly two true terminals.
//
// Green: southbound trains always originate at Harlem/Lake, but northbound
// could come from either Ashland/63rd or Cottage Grove and we can't tell which.
function defaultOriginResolver(line, destStationName) {
  const lineTerms = TRUE_TERMINALS[line];
  const uniqueStations = [...new Set(Object.values(lineTerms))];
  const candidates = uniqueStations.filter((n) => n !== destStationName);
  return candidates.length === 1 ? candidates[0] : null;
}

// Purple Express runs weekday rush only: SB Linden→Loop in the morning, NB
// Loop→Linden in the afternoon. Outside these windows, Purple is the
// Linden↔Howard shuttle. CTA's API doesn't tag express vs shuttle, so we read
// the time-of-day to pick the right origin for northbound trains (dest=Linden)
// and to map dest=Loop back to Linden as the SB express origin.
function purpleExpressNorthboundActive(now) {
  if (dayTypeFor(now) !== 'weekday') return false;
  const h = chicagoHour(now);
  return h >= 14 && h < 19;
}

const LINE_ORIGIN_RESOLVERS = {
  g: (_line, destStationName) =>
    destStationName === 'Ashland/63rd' || destStationName === 'Cottage Grove'
      ? 'Harlem/Lake'
      : null,
  p: (_line, destStationName, opts = {}) => {
    if (destStationName === 'Linden') {
      // NB express runs Loop↔Linden per CTA's timetable, originating at
      // Quincy. Mart is *north* of the Loop circuit, so using it as the
      // origin marker makes a Loop-side bunch render as if the trip started
      // somewhere the trains haven't reached yet.
      if (purpleExpressNorthboundActive(opts.now)) return 'Quincy';
      // Position fallback for NB express outside the time window (e.g. morning
      // deadhead pullouts): the shuttle only runs Linden↔Howard, so a train
      // snapped south of Howard on the line polyline can't be shuttle service.
      if (opts.leadSouthOfHoward) return 'Quincy';
      return 'Howard';
    }
    if (destStationName === 'Howard') return 'Linden';
    if (opts.dest === 'Loop') return 'Linden';
    return null;
  },
};

function findOrigin(bunch, stations, opts = {}) {
  const now = opts.now || new Date();
  const lineTerms = TRUE_TERMINALS[bunch.line];
  if (!lineTerms) return null;
  const dest = bunch.trains[0]?.destination;
  if (!dest) return null;
  const destStationName = lineTerms[dest] || null;
  const resolver = LINE_ORIGIN_RESOLVERS[bunch.line] || defaultOriginResolver;
  const originName = resolver(bunch.line, destStationName, {
    dest,
    now,
    leadSouthOfHoward: opts.leadSouthOfHoward,
  });
  if (!originName) return null;
  const st = (stations || []).find((s) => s.name === originName);
  return st ? { lat: st.lat, lon: st.lon } : null;
}

function buildTrainOverlaySvg(
  stationsWithPixels,
  atStationPixels,
  trainPixels,
  lineColor,
  widthPx,
  heightPx,
  terminalPixel,
  originPixel,
  bearingDeg = 0,
  arrowBearingDeg = null,
  unlabeledPinPixels = [],
  { ghostLegendSvg = null, clock = null, readout = null, highlightStation = null } = {},
) {
  const fontSize = 18;
  const labelHeight = fontSize + 8;

  // Station pin-s (Mapbox "small" pin) is ~20x30px at @2x. Use its bounding
  // radius as the exclusion for compass placement so labels sit right next to
  // the pin, not drifting across the map.
  const STATION_PIN_RADIUS = 14;
  const LABEL_GAP = 8; // gap between pin/halo edge and label rect
  const LABEL_COLLISION_PAD = 4; // padding when testing label-vs-label overlap

  // Reserved no-go boxes: train markers + their halos, and terminal (house/
  // flag) markers. Labels placed near trains should not slide over the train
  // icon.
  const reserved = [];
  for (const { x, y } of trainPixels) {
    const r = TRAIN_MARKER_RADIUS + 8;
    reserved.push({ x: x - r, y: y - r, w: r * 2, h: r * 2 });
  }
  if (terminalPixel) {
    const r = TERMINAL_MARKER_RADIUS + 4;
    reserved.push({ x: terminalPixel.x - r, y: terminalPixel.y - r, w: r * 2, h: r * 2 });
  }
  if (originPixel) {
    const r = TERMINAL_MARKER_RADIUS + 4;
    reserved.push({ x: originPixel.x - r, y: originPixel.y - r, w: r * 2, h: r * 2 });
  }
  // Station pins too — a label covering a neighboring station's pin hides
  // the thing the label is pointing at and confuses the reader. Tight pad
  // since pins are small (~14px). Reserve unlabeled pins as well: distant
  // stops get a pin but no label, and labels for nearby stations must still
  // avoid covering them.
  for (const { x, y } of stationsWithPixels) {
    const r = STATION_PIN_RADIUS + 2;
    reserved.push({ x: x - r, y: y - r, w: r * 2, h: r * 2 });
  }
  for (const { x, y } of unlabeledPinPixels) {
    const r = STATION_PIN_RADIUS + 2;
    reserved.push({ x: x - r, y: y - r, w: r * 2, h: r * 2 });
  }

  // Per-station bearing is used to compute that station's local "perpendicular
  // to the route" — the preferred label side. Lines with big bends (Green at
  // the Loop, Blue at the Kennedy) need per-station bearings because a single
  // global bearing would put labels along-route for stations on the other leg.
  function unitVectors(stationBearingDeg) {
    const perp = perpendicularFromBearing(stationBearingDeg);
    const brad = (stationBearingDeg * Math.PI) / 180;
    const along = { x: Math.sin(brad), y: -Math.cos(brad) };
    return { perp, along };
  }
  // Global bearing used for along-route sort order (so alternation walks in a
  // stable direction across the whole frame).
  const { along: globalAlong } = unitVectors(bearingDeg);

  // Build 8 candidates but ordered by preference. `side`: +1 = right-of-travel
  // first, -1 = left-of-travel first. Caller alternates per station.
  function candidates(pinX, pinY, radius, w, h, side, stationBearingDeg) {
    const r = radius + LABEL_GAP;
    const { perp, along } = unitVectors(stationBearingDeg);
    // Label rect's top-left for a placement centered on (cx, cy).
    const rectFrom = (cx, cy, anchor) => ({ x: cx - w / 2, y: cy - h / 2, anchor });
    const perpSide = (s) => {
      const cx = pinX + perp.x * (r + w / 2) * s;
      const cy = pinY + perp.y * (r + h / 2) * s;
      return rectFrom(cx, cy, 'middle');
    };
    // Preferred first: both sides perpendicular to the route, primary side first.
    // Then along-route +/- (useful on curves), then pure cardinals that may
    // coincide with perpendiculars on cardinal bearings (redundancy is fine —
    // the first hit wins).
    const primary = perpSide(side);
    const opposite = perpSide(-side);
    const alongPos = rectFrom(pinX + along.x * (r + w / 2), pinY + along.y * (r + h / 2), 'middle');
    const alongNeg = rectFrom(pinX - along.x * (r + w / 2), pinY - along.y * (r + h / 2), 'middle');
    // Cardinal + diagonal fallbacks, in case viewport edges clip the route-
    // relative placements.
    return [
      primary,
      opposite,
      alongPos,
      alongNeg,
      { x: pinX + r, y: pinY - h / 2, anchor: 'start' }, // E
      { x: pinX - r - w, y: pinY - h / 2, anchor: 'end' }, // W
      { x: pinX + r * 0.5, y: pinY + r * 0.5, anchor: 'start' }, // SE
      { x: pinX - r * 0.5 - w, y: pinY + r * 0.5, anchor: 'end' }, // SW
      { x: pinX + r * 0.5, y: pinY - r * 0.5 - h, anchor: 'start' }, // NE
      { x: pinX - r * 0.5 - w, y: pinY - r * 0.5 - h, anchor: 'end' }, // NW
    ];
  }

  function rectsOverlap(a, b) {
    return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
  }
  function inViewport(r) {
    return r.x >= 0 && r.y >= 0 && r.x + r.w <= widthPx && r.y + r.h <= heightPx;
  }

  // Sort stations along the route (by projected pixel position onto the route
  // bearing) so we can alternate which side of the track each label sits on.
  // Sort key is purely positional — adding a per-frame signal like `hasTrain`
  // would reorder placement as trains pass through, which makes labels for
  // bystander stations flip sides between frames.
  const sorted = [...stationsWithPixels].sort((a, b) => {
    const aProj = a.x * globalAlong.x + a.y * globalAlong.y;
    const bProj = b.x * globalAlong.x + b.y * globalAlong.y;
    return aProj - bProj;
  });

  const placed = [];
  const labels = [];
  let sideFlip = 1; // alternates +1/-1 along the route; trains force a reset
  for (const s of sorted) {
    const text = xmlEscape(shortStationName(s.station.name));
    const approxWidth = text.length * 10 + 16;
    // Always anchor labels to the station pin — never to a train passing
    // through. Anchoring to the train made the label slide along with the
    // train, which read as the station moving. The reserved train-marker
    // boxes still push labels off the train icon.
    const pinX = s.x;
    const pinY = s.y;
    const radius = STATION_PIN_RADIUS;

    const cands = candidates(
      pinX,
      pinY,
      radius,
      approxWidth,
      labelHeight,
      sideFlip,
      s.bearingDeg ?? bearingDeg,
    );
    sideFlip = -sideFlip;
    let chosen = null;
    for (const c of cands) {
      const box = { x: c.x, y: c.y, w: approxWidth, h: labelHeight };
      if (!inViewport(box)) continue;
      const pad = {
        x: box.x - LABEL_COLLISION_PAD,
        y: box.y - LABEL_COLLISION_PAD,
        w: box.w + LABEL_COLLISION_PAD * 2,
        h: box.h + LABEL_COLLISION_PAD * 2,
      };
      if (placed.some((p) => rectsOverlap(pad, p))) continue;
      if (reserved.some((r) => rectsOverlap(box, r))) continue;
      chosen = { ...c, box };
      break;
    }
    // No candidate fit cleanly — relax the label-vs-label constraint but
    // keep the train-marker exclusion hard. A label overlapping another label
    // is recoverable noise; a label covering a train hides the focal element
    // of the post, so we'd rather drop the label entirely.
    if (!chosen) {
      for (const c of cands) {
        const box = { x: c.x, y: c.y, w: approxWidth, h: labelHeight };
        if (!inViewport(box)) continue;
        if (reserved.some((r) => rectsOverlap(box, r))) continue;
        chosen = { ...c, box };
        break;
      }
    }
    if (!chosen) continue;

    placed.push(chosen.box);
    labels.push({
      label: text,
      rectX: chosen.x,
      rectY: chosen.y,
      approxWidth,
      anchor: chosen.anchor,
      isHighlight: highlightStation != null && s.station.name === highlightStation,
    });
  }

  // Amber target ring on the wait stop (gap timelapses) — the spot the rider is
  // waiting at, where the next train is heading. Amber ties it to the gap-strip
  // color language; the concentric rings + center dot read as "destination."
  const highlightMarkers = [];
  if (highlightStation) {
    const hs = stationsWithPixels.find((s) => s.station.name === highlightStation);
    if (hs) {
      highlightMarkers.push(
        `<circle cx="${hs.x}" cy="${hs.y}" r="22" fill="none" stroke="#ffb020" stroke-width="3" opacity="0.45"/>`,
        `<circle cx="${hs.x}" cy="${hs.y}" r="14" fill="none" stroke="#ffb020" stroke-width="4"/>`,
        `<circle cx="${hs.x}" cy="${hs.y}" r="4" fill="#ffb020"/>`,
      );
    }
  }

  // White ring halo for trains sitting at a station.
  const halos = atStationPixels.map(({ x, y }) => {
    return `<circle cx="${x}" cy="${y}" r="${TRAIN_MARKER_RADIUS + 8}" fill="none" stroke="#fff" stroke-width="4"/>`;
  });

  // Custom train markers. Ghost = "lost-signal" (CTA stopped reporting the
  // train mid-clip): desaturated gray fill + dashed ring + faded opacity so
  // viewers read it as tracking lost rather than a normal train. Turnaround =
  // train arrived at a real terminus (not a Loop apex) and dropped off the
  // API for the trip-flip — render as a loop-arrow glyph in line color so
  // viewers read "arrived" instead of "lost track."
  // Comet motion trails (video only): each train carries pre-projected, nudge-
  // aligned `trail` pixels. Drawn below the markers so the streak reads as
  // "behind" the train.
  const trailElements = trainPixels.map(({ trail }) =>
    trail && trail.length >= 2 ? buildCometTrail(trail) : '',
  );

  const iconSize = TRAIN_MARKER_RADIUS * 1.6;
  const trainMarkers = trainPixels.map(({ x, y, ghost, turnaround, opacity }) => {
    if (turnaround) {
      return buildTurnaroundMarker({
        x,
        y,
        radius: TRAIN_MARKER_RADIUS,
        color: lineColor,
        opacity,
      });
    }
    const iconX = x - iconSize / 2;
    const iconY = y - iconSize / 2;
    const fill = ghost ? '888888' : lineColor;
    const dashAttr = ghost ? ' stroke-dasharray="6 4"' : '';
    const body = [
      `<circle cx="${x}" cy="${y}" r="${TRAIN_MARKER_RADIUS}" fill="#${fill}" stroke="#fff" stroke-width="4"${dashAttr}/>`,
      `<svg x="${iconX}" y="${iconY}" width="${iconSize}" height="${iconSize}" viewBox="0 0 36 36">${TWEMOJI_TRAIN_INNER}</svg>`,
    ].join('');
    return ghost ? `<g opacity="${opacity}">${body}</g>` : body;
  });
  // Identity chips in their own layer ABOVE every disc, so an overlapping train
  // can never bury another train's number.
  const chipElements = trainPixels.map(({ x, y, label }) =>
    markerLabelChip(x, y, TRAIN_MARKER_RADIUS, label),
  );

  // Direction-of-travel arrow in the top-right corner.
  const arrows = [];
  if (trainPixels.length > 0) {
    const arrowDeg = arrowBearingDeg != null ? arrowBearingDeg : trainPixels[0].bearingDeg;
    arrows.push(buildDirectionArrow(widthPx - 220, 180, arrowDeg));
  }

  const labelElements = labels.map(({ label, rectX, rectY, approxWidth, anchor, isHighlight }) => {
    // Text x depends on text-anchor: start → left edge, middle → center,
    // end → right edge. Keeps the text visually centered within its rect.
    const textX =
      anchor === 'start'
        ? rectX + 8
        : anchor === 'end'
          ? rectX + approxWidth - 8
          : rectX + approxWidth / 2;
    const textY = rectY + fontSize + 2;
    // Wait stop (gap timelapse): amber fill + dark bold text so the destination
    // the train is approaching stands out from the white context labels. Same
    // font size so the collision-avoidance placement stays valid.
    if (isHighlight) {
      return `
    <rect x="${rectX}" y="${rectY}" width="${approxWidth}" height="${labelHeight}" fill="#ffb020" rx="3"/>
    <text x="${textX}" y="${textY}" fill="#1c1c1c" text-anchor="${anchor}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="700">${label}</text>`;
    }
    return `
    <rect x="${rectX}" y="${rectY}" width="${approxWidth}" height="${labelHeight}" fill="#000" fill-opacity="0.8" rx="3"/>
    <text x="${textX}" y="${textY}" fill="#fff" text-anchor="${anchor}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="600">${label}</text>`;
  });

  // Origin (house) and destination (flag) markers — draw below trains so a
  // train sitting at either still reads clearly, and below labels. Either may
  // be absent (Loop-bound trains have no flag; Green has no house; off-screen
  // points are dropped upstream).
  const terminalElements = [];
  if (originPixel)
    terminalElements.push(
      ...buildTerminalMarker(
        originPixel.x,
        originPixel.y,
        TERMINAL_MARKER_RADIUS,
        TWEMOJI_HOUSE_INNER,
      ),
    );
  if (terminalPixel)
    terminalElements.push(
      ...buildTerminalMarker(
        terminalPixel.x,
        terminalPixel.y,
        TERMINAL_MARKER_RADIUS,
        TWEMOJI_FLAG_INNER,
      ),
    );

  // Draw labels before trains+halos so a stray overlap never hides a train.
  // Placement already avoids reserved train boxes, so this is belt-and-suspenders.
  // Ghost legend (top-left): pre-rendered by the async caller since width
  // measurement is async. Arrow lives top-right so they don't fight.
  const legendElements = ghostLegendSvg ? [ghostLegendSvg] : [];
  const progressElements = clock
    ? [buildClipProgress({ ...clock, width: widthPx, height: heightPx })]
    : [];
  // Gap timelapses pass a pre-built "next train ~N min to X" readout pill
  // (measured + built async by the caller). Top-left, same corner as the ghost
  // legend — gap clips follow one mid-line train and carry no ghost legend, so
  // they never collide in practice.
  const readoutElements = readout ? [readout] : [];
  const elements = [
    ...terminalElements,
    ...highlightMarkers,
    ...labelElements,
    ...trailElements,
    ...halos,
    ...trainMarkers,
    ...chipElements,
    ...arrows,
    ...legendElements,
    ...readoutElements,
    ...progressElements,
  ].join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}">${elements}</svg>`;
}

function computeTrainBunchingView(
  bunch,
  lineColors,
  trainLines,
  stations,
  extraTrains = [],
  opts = {},
) {
  const color = lineColors[bunch.line] || 'ffffff';

  const { points: linePts, cumDist: lineCumDist } = buildLinePolyline(trainLines, bunch.line);
  const trainTrackDists = bunch.trains.map((t) => snapToLine(t.lat, t.lon, linePts, lineCumDist));
  const minTrainDist = Math.min(...trainTrackDists);
  const maxTrainDist = Math.max(...trainTrackDists);

  const onLineStations = (stations || []).filter((s) => s.lines?.includes(bunch.line));
  const stationsWithDist = onLineStations.map((s) => ({
    station: s,
    trackDist: snapToLine(s.lat, s.lon, linePts, lineCumDist),
  }));

  // Resolve origin/destination up front so framing can be clipped to the trip.
  // Without this, Purple's single Linden→Loop polyline lets a shuttle bunch at
  // Howard pull `ahead[0]` down to a Loop-side express station (e.g. Belmont),
  // stretching the bbox ~5 mi south and clipping the trains at the frame edge.
  const howardEntry = stationsWithDist.find((s) => s.station.name === 'Howard');
  const leadSouthOfHoward =
    bunch.line === 'p' && howardEntry && trainTrackDists[0] > howardEntry.trackDist;
  const terminal = findTerminal(bunch, stations);
  const origin = findOrigin(bunch, stations, { leadSouthOfHoward });

  // Clip framing stations to the origin↔destination range (Purple only — other
  // lines don't have the round-trip-polyline issue and branched lines like
  // Green have unreliable cross-branch trackDists).
  let framingStations = stationsWithDist;
  if (bunch.line === 'p' && origin && terminal) {
    const originEntry = stationsWithDist.find(
      (s) => s.station.lat === origin.lat && s.station.lon === origin.lon,
    );
    const terminalEntry = stationsWithDist.find(
      (s) => s.station.lat === terminal.lat && s.station.lon === terminal.lon,
    );
    if (originEntry && terminalEntry) {
      const lo = Math.min(originEntry.trackDist, terminalEntry.trackDist);
      const hi = Math.max(originEntry.trackDist, terminalEntry.trackDist);
      framingStations = stationsWithDist.filter((s) => s.trackDist >= lo && s.trackDist <= hi);
    }
  }

  const behind = framingStations
    .filter((s) => s.trackDist < minTrainDist)
    .sort((a, b) => b.trackDist - a.trackDist);
  const ahead = framingStations
    .filter((s) => s.trackDist > maxTrainDist)
    .sort((a, b) => a.trackDist - b.trackDist);
  const between = framingStations
    .filter((s) => s.trackDist >= minTrainDist && s.trackDist <= maxTrainDist)
    .sort((a, b) => a.trackDist - b.trackDist);

  const nearestStations = [];
  if (behind.length > 0) nearestStations.push(behind[0].station);
  if (between.length > 0) nearestStations.push(between[0].station);
  if (ahead.length > 0) nearestStations.push(ahead[0].station);
  if (nearestStations.length < 2) {
    const bunchLat = bunch.trains.reduce((a, t) => a + t.lat, 0) / bunch.trains.length;
    const bunchLon = bunch.trains.reduce((a, t) => a + t.lon, 0) / bunch.trains.length;
    const already = new Set(nearestStations.map((s) => s.name));
    const fallback = onLineStations
      .filter((s) => !already.has(s.name))
      .sort(
        (a, b) =>
          haversineFt({ lat: bunchLat, lon: bunchLon }, a) -
          haversineFt({ lat: bunchLat, lon: bunchLon }, b),
      );
    for (const s of fallback) {
      if (nearestStations.length >= 2) break;
      nearestStations.push(s);
    }
  }

  // Build bbox to include the bunched trains AND the chosen stations.
  // Video captures pass extraTrains so later frames stay in-frame too.
  const framingTrains = [...bunch.trains, ...extraTrains];
  const allLats = [...framingTrains.map((t) => t.lat), ...nearestStations.map((s) => s.lat)];
  const allLons = [...framingTrains.map((t) => t.lon), ...nearestStations.map((s) => s.lon)];
  const bbox = {
    minLat: Math.min(...allLats) - TRAIN_BUNCH_BBOX_PADDING_DEG,
    maxLat: Math.max(...allLats) + TRAIN_BUNCH_BBOX_PADDING_DEG,
    minLon: Math.min(...allLons) - TRAIN_BUNCH_BBOX_PADDING_DEG,
    maxLon: Math.max(...allLons) + TRAIN_BUNCH_BBOX_PADDING_DEG,
  };
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;
  // Integer zoom. Mapbox may round fractional zooms, decoupling our projection
  // math from the actual image. Always floor so the bbox is guaranteed to fit
  // — ceiling pushes one zoom level tighter than fitZoom, which clips
  // bbox-edge trains. Hit on Purple express bunches around the Howard↔Wilson
  // dead zone: ahead[0] jumps to the next Purple-only stop ~20kft away, the
  // bbox spans ~3.5 mi, and ceiling renders the trains off-frame.
  const rawZoom = fitZoom(bbox, WIDTH, HEIGHT, 60);
  // Wide gaps (e.g. a Blue Line gap spanning Rosemont → past Harlem) need a
  // lower floor than a typical bunch — clamping to 10 re-clipped the trains
  // we were trying to keep on-screen.
  const minZoom = opts.fitBbox ? 8 : 10;
  const zoom = Math.max(minZoom, Math.min(17, Math.floor(rawZoom)));

  // Full line segments so the route runs off the edges of the frame.
  const overlays = [];
  const lineSegments = trainLines?.[bunch.line] || [];
  for (const seg of lineSegments) {
    if (seg.length < 2) continue;
    overlays.push(`path-7+${color}-0.7(${encodeURIComponent(encode(seg))})`);
  }

  // Label only the stations immediately flanking the bunch, not every on-line
  // station in the viewport. Wide bunches (e.g. Blue Line trains on both
  // branches) otherwise produced a forest of labels stretching well past the
  // bunch itself, crowding the image and pulling attention off the actual
  // event. Behind/ahead are capped at N on each side along the route.
  // For gaps (where `between` can span 10+ stations), cap between too and
  // evenly sample so endpoints + interior context are both represented.
  const LABELED_PER_SIDE = 3;
  const LABELED_BETWEEN_MAX = 8;
  function sampleEvenly(arr, max) {
    if (arr.length <= max) return arr;
    const out = [];
    const step = (arr.length - 1) / (max - 1);
    const seen = new Set();
    for (let i = 0; i < max; i++) {
      const idx = Math.round(i * step);
      if (!seen.has(idx)) {
        seen.add(idx);
        out.push(arr[idx]);
      }
    }
    return out;
  }
  const labeledSet = new Set([
    ...behind.slice(0, LABELED_PER_SIDE).map((s) => s.station.name),
    ...sampleEvenly(between, LABELED_BETWEEN_MAX).map((s) => s.station.name),
    ...ahead.slice(0, LABELED_PER_SIDE).map((s) => s.station.name),
  ]);
  // Compute per-station local route bearing by finding the nearest polyline
  // segment and taking that segment's heading. Lines with big bends (Green at
  // the Loop, Blue at the Kennedy) need this because a global bearing puts
  // the "perpendicular" direction along-route for stations on the other leg,
  // which re-introduces the stacking problem we're trying to fix.
  const allSegPoints = lineSegments.flatMap((seg) => seg.map(([lat, lon]) => ({ lat, lon })));
  function localBearingFor(pt) {
    if (allSegPoints.length < 2) return 0;
    let bestDist = Infinity;
    let bestA = null;
    let bestB = null;
    for (let i = 0; i < allSegPoints.length - 1; i++) {
      const a = allSegPoints[i];
      const b = allSegPoints[i + 1];
      const dx = b.lon - a.lon;
      const dy = b.lat - a.lat;
      const lenSq = dx * dx + dy * dy;
      let t = 0;
      if (lenSq > 0)
        t = Math.max(0, Math.min(1, ((pt.lon - a.lon) * dx + (pt.lat - a.lat) * dy) / lenSq));
      const proj = { lat: a.lat + t * dy, lon: a.lon + t * dx };
      const d = haversineFt(pt, proj);
      if (d < bestDist) {
        bestDist = d;
        bestA = a;
        bestB = b;
      }
    }
    return bearing(bestA, bestB);
  }

  // Pin every on-line station that falls inside the frame, but only label the
  // ones in `labeledSet`. As the video plays, the trains travel beyond the
  // initial bunch area and the bbox widens via `extraTrains`; without pins
  // for the further-out stops, viewers lose track-context once trains leave
  // the labeled cluster. Keeping the pin density high but the label density
  // low gives orientation without crowding text near the bunch event.
  const pinStations = onLineStations
    .map((s) => {
      const pixels = project(s.lat, s.lon, centerLat, centerLon, zoom, WIDTH, HEIGHT);
      return { station: s, ...pixels };
    })
    .filter(({ x, y }) => x >= 0 && x <= WIDTH && y >= 0 && y <= HEIGHT);

  const visibleStations = pinStations
    .filter(({ station: s }) => labeledSet.has(s.name))
    .map(({ station: s, x, y }) => ({ station: s, x, y, bearingDeg: localBearingFor(s) }));

  for (const { station: s } of pinStations) {
    overlays.push(`pin-s+ffffff(${s.lon.toFixed(5)},${s.lat.toFixed(5)})`);
  }

  function nearestSegment(pt) {
    let bestDist = Infinity;
    let bestA = null;
    let bestB = null;
    for (let i = 0; i < allSegPoints.length - 1; i++) {
      const a = allSegPoints[i];
      const b = allSegPoints[i + 1];
      const dx = b.lon - a.lon;
      const dy = b.lat - a.lat;
      const lenSq = dx * dx + dy * dy;
      let t = 0;
      if (lenSq > 0)
        t = Math.max(0, Math.min(1, ((pt.lon - a.lon) * dx + (pt.lat - a.lat) * dy) / lenSq));
      const proj = { lat: a.lat + t * dy, lon: a.lon + t * dx };
      const d = haversineFt(pt, proj);
      if (d < bestDist) {
        bestDist = d;
        bestA = a;
        bestB = b;
      }
    }
    return { from: bestA, to: bestB };
  }
  const leadTrain = bunch.trains[0];
  // Base bearing: nearest-segment, used for marker perpendicular-fanning and
  // as station-label bearing fallback. Perpendicular fanning is sign-agnostic
  // (axis flips are symmetric), so we don't need the orientation to be
  // correct here — just track-aligned. The old heading-flip was unsafe: a
  // train parked at a terminal often reports a heading 180° off its actual
  // service direction, which would invert the arrow.
  let bearingDeg = leadTrain.heading;
  let trackFwd = null;
  let trackRev = null;
  if (allSegPoints.length >= 2) {
    const { from, to } = nearestSegment(leadTrain);
    trackFwd = bearing(from, to);
    trackRev = (trackFwd + 180) % 360;
    bearingDeg = trackFwd;
  }

  // Arrow bearing for the direction-of-travel indicator. Direction comes from
  // the trip reference (train → terminal, or origin → train) — that's the
  // authoritative service direction, unlike `leadTrain.heading` which can be
  // arbitrary at a terminal layover. On zoomed-out views we use the raw trip
  // vector; on tight zooms we align it to the nearest track segment so the
  // arrow matches the rails the train is on.
  let arrowBearingDeg = bearingDeg;
  const arrowRef = terminal || origin;
  if (arrowRef) {
    const refBearing = terminal ? bearing(leadTrain, terminal) : bearing(origin, leadTrain);
    const leadPx = project(leadTrain.lat, leadTrain.lon, centerLat, centerLon, zoom, WIDTH, HEIGHT);
    const refPx = project(arrowRef.lat, arrowRef.lon, centerLat, centerLon, zoom, WIDTH, HEIGHT);
    const pixelDist = Math.hypot(refPx.x - leadPx.x, refPx.y - leadPx.y);
    const FAR_PX = 400;
    if (pixelDist > FAR_PX || trackFwd == null) {
      arrowBearingDeg = refBearing;
    } else {
      // Pick whichever of track fwd/rev is closer to the trip vector — that
      // gives a track-aligned arrow pointing in the correct service direction.
      const diffFwd = Math.abs(((refBearing - trackFwd + 540) % 360) - 180);
      const diffRev = Math.abs(((refBearing - trackRev + 540) % 360) - 180);
      arrowBearingDeg = diffFwd <= diffRev ? trackFwd : trackRev;
    }
  }

  return {
    color,
    overlays,
    centerLat,
    centerLon,
    zoom,
    visibleStations,
    pinStations,
    bearingDeg,
    arrowBearingDeg,
    terminal,
    origin,
  };
}

async function fetchTrainBunchingBaseMap(view) {
  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${view.overlays.join(',')}/${view.centerLon.toFixed(5)},${view.centerLat.toFixed(5)},${view.zoom.toFixed(2)}/${WIDTH}x${HEIGHT}@2x?access_token=${token}`;
  return fetchMapboxStatic(url);
}

async function renderTrainBunchingFrame(view, baseMap, trains, opts = {}) {
  // Project each train, then nudge overlapping markers apart so a tight bunch
  // still shows every train instead of stacking them into one disc. Halos and
  // labels anchor to the separated pixels so they follow the visible markers.
  const rawTrainPixels = trains.map((t) =>
    project(t.lat, t.lon, view.centerLat, view.centerLon, view.zoom, WIDTH, HEIGHT),
  );
  const separated = separateMarkers(rawTrainPixels, TRAIN_MARKER_RADIUS * 2 + 4, {
    axis: perpendicularFromBearing(view.bearingDeg),
  });
  const labels = opts.labels || null;
  const trainPixels = separated.map(({ x, y }, idx) => {
    // Shift trail points by the same nudge the disc got so the streak stays
    // attached to its (possibly nudged) marker head.
    const dx = x - rawTrainPixels[idx].x;
    const dy = y - rawTrainPixels[idx].y;
    const trail = (trains[idx]?.trail || []).map((pt) => {
      const p = project(pt.lat, pt.lon, view.centerLat, view.centerLon, view.zoom, WIDTH, HEIGHT);
      return { x: p.x + dx, y: p.y + dy };
    });
    return {
      x,
      y,
      bearingDeg: view.bearingDeg,
      ghost: trains[idx]?.ghost === true,
      turnaround: trains[idx]?.turnaround === true,
      opacity: trains[idx]?.opacity ?? 1,
      label: labels ? (labels.get(trains[idx]?.rn) ?? null) : null,
      trail,
    };
  });

  const stationsWithPixels = view.visibleStations.map(({ station, x, y, bearingDeg }) => ({
    station,
    x,
    y,
    bearingDeg,
  }));
  const atStationPixels = trains
    .map((t, idx) => ({ t, idx }))
    // Ghosts are dead-reckoned positions, not real GPS — don't paint
    // at-station halos on them since we don't actually know they stopped.
    .filter(
      ({ t }) =>
        !t.ghost &&
        view.visibleStations.some(
          (v) => haversineFt({ lat: v.station.lat, lon: v.station.lon }, t) < AT_STATION_FT,
        ),
    )
    .map(({ idx }) => ({ x: separated[idx].x, y: separated[idx].y }));

  function projectIfVisible(point) {
    if (!point) return null;
    const { x, y } = project(
      point.lat,
      point.lon,
      view.centerLat,
      view.centerLon,
      view.zoom,
      WIDTH,
      HEIGHT,
    );
    return x >= 0 && x <= WIDTH && y >= 0 && y <= HEIGHT ? { x, y } : null;
  }
  const terminalPixel = projectIfVisible(view.terminal);
  const originPixel = projectIfVisible(view.origin);

  const labeledNames = new Set(view.visibleStations.map((v) => v.station.name));
  const unlabeledPinPixels = (view.pinStations || [])
    .filter(({ station }) => !labeledNames.has(station.name))
    .map(({ x, y }) => ({ x, y }));

  // Pre-render the ghost legend (async — measures text width via librsvg)
  // so the otherwise-sync overlay builder can splice it in directly.
  const ghostLegendSvg = opts.showGhostLegend ? await buildGhostLegend(20, 20) : null;
  // Measure the readout text so its pill hugs the words (sync per-char width
  // over-padded it). Bold measurement slightly over-reserves vs the 600 weight,
  // which is the safe direction — text never spills the rounded backdrop.
  let readoutSvg = null;
  if (opts.readout) {
    const tw = await measureTextWidth(opts.readout, 26, { bold: true });
    readoutSvg = buildReadoutPill(opts.readout, { textWidth: tw });
  }
  const svg = buildTrainOverlaySvg(
    stationsWithPixels,
    atStationPixels,
    trainPixels,
    view.color,
    WIDTH,
    HEIGHT,
    terminalPixel,
    originPixel,
    view.bearingDeg,
    view.arrowBearingDeg,
    unlabeledPinPixels,
    {
      ghostLegendSvg,
      clock: opts.clock || null,
      readout: readoutSvg,
      highlightStation: opts.highlightStation || null,
    },
  );
  // Gap still maps pass a `gapPath` to dash over the solid route in the line
  // color (Mapbox static paths can't dash). Composite it as its own layer first
  // so it sits under the train markers and station labels.
  const layers = [];
  if (view.gapPath?.length >= 2) {
    const gapPixels = view.gapPath.map((p) =>
      project(p.lat, p.lon, view.centerLat, view.centerLon, view.zoom, WIDTH, HEIGHT),
    );
    const gapEls = buildDashedGapSvg(gapPixels, view.color, { coreStroke: 7 });
    if (gapEls) {
      const gapSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${gapEls}</svg>`;
      layers.push({ input: Buffer.from(gapSvg), top: 0, left: 0 });
    }
  }
  // When the gap view strips the base-map pins (so they don't bake under the
  // dash), redraw them in an SVG layer above the dash — but below the main
  // overlay so station labels and train markers still sit on top.
  if (view.drawPinsInSvg && view.pinStations?.length) {
    const pinEls = view.pinStations
      .filter(({ x, y }) => x >= 0 && x <= WIDTH && y >= 0 && y <= HEIGHT)
      .map(({ x, y }) => buildStationPinDotSvg(x, y))
      .join('');
    if (pinEls) {
      const pinSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${pinEls}</svg>`;
      layers.push({ input: Buffer.from(pinSvg), top: 0, left: 0 });
    }
  }
  layers.push({ input: Buffer.from(svg), top: 0, left: 0 });
  return sharp(baseMap).resize(WIDTH, HEIGHT).composite(layers).jpeg({ quality: 85 }).toBuffer();
}

async function renderTrainBunching(bunch, lineColors, trainLines, stations, opts = {}) {
  const view = computeTrainBunchingView(bunch, lineColors, trainLines, stations);
  const baseMap = await fetchTrainBunchingBaseMap(view);
  return renderTrainBunchingFrame(view, baseMap, bunch.trains, { labels: opts.labels || null });
}

module.exports = {
  renderTrainBunching,
  computeTrainBunchingView,
  fetchTrainBunchingBaseMap,
  renderTrainBunchingFrame,
};
