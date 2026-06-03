// Spatial relevance check for alert quote-posting: does `station` lie on the
// segment between `fromStation` and `toStation` on a given line, optionally
// constrained to a direction? Used to decide whether a bunching/gap post on a
// specific station should be quote-replied into an active alert thread.
//
// Fail-closed: any unresolved station name returns false. We'd rather miss a
// quote-post than spam an unrelated thread.

const trainStations = require('../train/data/trainStations.json');
const trainLines = require('../train/data/trainLines.json');
const { snapToLineWithPerp, buildLineBranches } = require('../train/speedmap.js');

// Compass → directionHint mapping per round-trip line. Round-trip lines run
// outbound (away from Loop) and inbound (toward Loop). For brn/org/pink/p we
// translate compass directions to the matching directionHint, so callers
// passing extractDirection's 'in'/'out'/'north'/etc. all work.
//
// north/south/east/west on round-trip lines: pick the branch whose terminus
// lies in that compass direction from the Loop. brn (Kimball, north): NB→out.
// org (Midway, south): SB→out. pink (54th/Cermak, southwest): WB/SB→out. p
// (Linden, north): NB→out.
const COMPASS_TO_HINT = {
  brn: { north: 'outbound', south: 'inbound', out: 'outbound', in: 'inbound' },
  org: { south: 'outbound', north: 'inbound', west: 'outbound', out: 'outbound', in: 'inbound' },
  pink: { west: 'outbound', east: 'inbound', south: 'outbound', out: 'outbound', in: 'inbound' },
  p: { north: 'outbound', south: 'inbound', out: 'outbound', in: 'inbound' },
};

// Train Tracker `trDr` codes per line. Derived empirically from observed
// destination strings (see scripts/observeTrains.js obs):
//   - red:  trDr=1 → Howard (north),  trDr=5 → 95th/Dan Ryan (south)
//   - blue: trDr=1 → O'Hare (NW),     trDr=5 → Forest Park (W)
//   - g:    trDr=1 → Harlem/Lake (W), trDr=5 → Ashland/63rd or Cottage Grove (S/E)
//   - y:    trDr=1 → Skokie (N),      trDr=5 → Howard (S)
//   - brn:  trDr=1 → Kimball (N out), trDr=5 → Loop (S/E in)
//   - org:  trDr=5 → Midway (S/W out),trDr=1 → Loop (N/E in)
//   - p:    trDr=1 → Linden (N out),  trDr=5 → Howard (S in)
//   - pink: trDr=5 → 54th/Cermak (W/S out), trDr=1 → Loop (N/E in)
// Used to translate an alert's compass-direction phrasing into the trDr that
// bunching_events / gap_events store on `direction`. Lookup is line-keyed
// because lines disagree on convention (red 1=N vs y 1=N, vs blue/brn).
const COMPASS_TO_TRDR = {
  red: { north: '1', south: '5', in: '5', out: '1' },
  blue: { north: '1', west: '5', east: '1', south: '5', in: '1', out: '5' },
  g: { west: '1', east: '5', south: '5', north: '1', in: '5', out: '1' },
  y: { north: '1', south: '5', in: '5', out: '1' },
  brn: { north: '1', south: '5', out: '1', in: '5' },
  org: { south: '5', west: '5', north: '1', east: '1', out: '5', in: '1' },
  p: { north: '1', south: '5', out: '1', in: '5' },
  pink: { west: '5', south: '5', east: '1', north: '1', out: '5', in: '1' },
};

// Pulse_state.direction has its own format: 'branch-N-outbound' / 'branch-N-
// inbound' for round-trip lines, 'all' for single-branch lines, or
// 'branch-len{k}-…' for multi-branch bidirectional lines (red/blue/g/y).
// Reduce to a normalized direction word the rest of the matcher understands.
function normalizePulseDirection(direction) {
  if (!direction) return null;
  if (direction === 'all') return null;
  if (direction.endsWith('-outbound')) return 'out';
  if (direction.endsWith('-inbound')) return 'in';
  // 'branch-len…' / 'branch-N' formats carry no compass — caller falls back
  // to no-direction-filter behavior.
  return null;
}

function compassToTrDr(line, direction) {
  if (!line || !direction) return null;
  const map = COMPASS_TO_TRDR[line];
  if (!map) return null;
  return map[direction] || null;
}

const DEFAULT_BUFFER_FT = 2640; // ½ mile fallback

function normalizeStationName(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveStation(name, line) {
  if (!name) return null;
  const norm = normalizeStationName(name);
  if (!norm) return null;
  const candidates = trainStations.filter((s) => s.lines?.includes(line));
  // exact match on normalized full name
  for (const s of candidates) {
    if (normalizeStationName(s.name) === norm) return s;
  }
  // exact match on base name (already stripped via normalize)
  for (const s of candidates) {
    const baseFull = s.name.toLowerCase().split(' (')[0].trim();
    if (baseFull === norm) return s;
  }
  return null;
}

function pickBranch(branches, line, direction) {
  if (branches.length === 0) return null;
  if (branches.length === 1) return branches[0];
  if (!direction) return branches[0];
  const map = COMPASS_TO_HINT[line];
  const wantHint = map ? map[direction] : null;
  if (!wantHint) return branches[0];
  const matched = branches.find((b) => b.directionHint === wantHint);
  return matched || branches[0];
}

// Median inter-station gap projected onto the chosen branch. Used as the per-
// stop buffer unit so `bufferStops=1` corresponds to one stop's slack.
function medianStationGap(branch, line) {
  const stations = trainStations.filter((s) => s.lines?.includes(line));
  if (stations.length < 2) return DEFAULT_BUFFER_FT;
  const dists = stations
    .map((s) => snapToLineWithPerp(s.lat, s.lon, branch.points, branch.cumDist).cumDist)
    .sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < dists.length; i++) gaps.push(dists[i] - dists[i - 1]);
  if (gaps.length === 0) return DEFAULT_BUFFER_FT;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return median > 0 ? median : DEFAULT_BUFFER_FT;
}

function isStationOnSegment({
  line,
  direction = null,
  station,
  fromStation,
  toStation,
  bufferStops = 1,
}) {
  if (!line || !station || !fromStation || !toStation) return false;
  const target = resolveStation(station, line);
  const from = resolveStation(fromStation, line);
  const to = resolveStation(toStation, line);
  if (!target || !from || !to) return false;

  const branches = buildLineBranches(trainLines, line);
  const branch = pickBranch(branches, line, direction);
  if (!branch?.points?.length) return false;

  // If a direction was requested but the line has direction-distinct branches
  // and no branch matches the requested direction, fail closed.
  if (direction && branches.length > 1 && COMPASS_TO_HINT[line]) {
    const wantHint = COMPASS_TO_HINT[line][direction];
    if (wantHint && branch.directionHint !== wantHint) return false;
  }

  const tDist = snapToLineWithPerp(target.lat, target.lon, branch.points, branch.cumDist).cumDist;
  const fDist = snapToLineWithPerp(from.lat, from.lon, branch.points, branch.cumDist).cumDist;
  const oDist = snapToLineWithPerp(to.lat, to.lon, branch.points, branch.cumDist).cumDist;

  const segMin = Math.min(fDist, oDist);
  const segMax = Math.max(fDist, oDist);
  const buffer = bufferStops * medianStationGap(branch, line);
  return tDist >= segMin - buffer && tDist <= segMax + buffer;
}

// Pick the branch that an endpoint pair actually rides. When `direction`
// resolves a hint we honor it (same as pickBranch); otherwise — or when the
// hinted branch doesn't contain both endpoints — fall back to the branch that
// minimizes the two endpoints' combined perpendicular distance. This is what
// lets enumeration work on multi-branch lines (red/blue/green) where a bare
// "between A and B" carries no usable compass and branches[0] may be the wrong
// fork.
function pickBranchForEndpoints(branches, line, direction, from, to) {
  if (branches.length === 0) return null;
  if (branches.length === 1) return branches[0];
  const hinted = pickBranch(branches, line, direction);
  let best = null;
  let bestPerp = Number.POSITIVE_INFINITY;
  for (const b of branches) {
    if (!b?.points?.length) continue;
    const fp = snapToLineWithPerp(from.lat, from.lon, b.points, b.cumDist).perpDist;
    const op = snapToLineWithPerp(to.lat, to.lon, b.points, b.cumDist).perpDist;
    const perp = fp + op;
    if (perp < bestPerp) {
      bestPerp = perp;
      best = b;
    }
  }
  // Prefer the directional hint only when it's also a good geometric fit for
  // both endpoints (within ~1000 ft each, the off-branch reject threshold used
  // elsewhere). Otherwise trust the geometry.
  if (hinted?.points?.length) {
    const fp = snapToLineWithPerp(from.lat, from.lon, hinted.points, hinted.cumDist).perpDist;
    const op = snapToLineWithPerp(to.lat, to.lon, hinted.points, hinted.cumDist).perpDist;
    if (fp <= 1000 && op <= 1000) return hinted;
  }
  return best || branches[0];
}

// Enumerate every roster station on the segment between `fromStation` and
// `toStation` (inclusive of both endpoints) on `line`, ordered from the `from`
// end toward the `to` end. This is the inner-station fill that `from`/`to`
// alone omit — "Rockwell → Montrose" expands to Rockwell, Western, Damen,
// Montrose so each one can be tied to the incident downstream.
//
// Fail-closed (same contract as isStationOnSegment): returns [] if either
// endpoint can't be resolved or the branch can't be built. The small buffer
// only guards numeric edge cases at the endpoints — it's well under one stop
// gap, so the neighbors just outside the segment are not pulled in.
function stationsOnSegment({ line, direction = null, fromStation, toStation, bufferStops = 0.25 }) {
  if (!line || !fromStation || !toStation) return [];
  const from = resolveStation(fromStation, line);
  const to = resolveStation(toStation, line);
  if (!from || !to) return [];

  const branches = buildLineBranches(trainLines, line);
  const branch = pickBranchForEndpoints(branches, line, direction, from, to);
  if (!branch?.points?.length) return [];

  const fDist = snapToLineWithPerp(from.lat, from.lon, branch.points, branch.cumDist).cumDist;
  const oDist = snapToLineWithPerp(to.lat, to.lon, branch.points, branch.cumDist).cumDist;
  const segMin = Math.min(fDist, oDist);
  const segMax = Math.max(fDist, oDist);
  const buffer = bufferStops * medianStationGap(branch, line);

  const hits = [];
  for (const s of trainStations) {
    if (!s.lines?.includes(line)) continue;
    const proj = snapToLineWithPerp(s.lat, s.lon, branch.points, branch.cumDist);
    if (proj.cumDist >= segMin - buffer && proj.cumDist <= segMax + buffer) {
      hits.push({ name: s.name, d: proj.cumDist });
    }
  }
  // Order along the branch in the from→to direction.
  hits.sort((a, b) => (fDist <= oDist ? a.d - b.d : b.d - a.d));
  return hits.map((h) => h.name);
}

module.exports = {
  isStationOnSegment,
  stationsOnSegment,
  normalizeStationName,
  resolveStation,
  COMPASS_TO_HINT,
  COMPASS_TO_TRDR,
  compassToTrDr,
  normalizePulseDirection,
};
