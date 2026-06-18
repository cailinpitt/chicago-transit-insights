// Cross-line train bunching — trains from 2+ lines stacked at one spot. The
// per-line detector in bunching.js groups by (line, trDr) and snaps to that
// line's polyline, so it never compares a Brown train against an Orange one.
// On the shared Loop elevated structure (Brown/Orange/Pink/Purple all run the
// same track), a real pileup spans lines. Here we cluster purely on geography
// across ALL lines, then require 2+ lines and congestion.
const { clusterByProximity, clusterStats } = require('../shared/geoClusters');

const CROSS_RADIUS_FT = 1500; // station + platform approach (trains are long)
const MIN_TRAINS = 3;
const MIN_LINES = 2;
const MIN_STOPPED = 2; // congestion evidence — a real pileup, not trains passing through

// `trains` carry { rn, line, lat, lon }. `stoppedRns` is a Set of run numbers
// the caller has confirmed barely-moving (the congestion gate). Omit it to
// detect on geometry alone (tests / diagnostics). Best-first: most trains,
// tie-break tightest span.
function detectCrossLineBunches(
  trains,
  {
    stoppedRns = null,
    radiusFt = CROSS_RADIUS_FT,
    minTrains = MIN_TRAINS,
    minLines = MIN_LINES,
    minStopped = MIN_STOPPED,
  } = {},
) {
  const positioned = (trains || []).filter(
    (t) => Number.isFinite(t?.lat) && Number.isFinite(t?.lon) && t?.line,
  );

  const out = [];
  for (const members of clusterByProximity(positioned, { radiusFt })) {
    if (members.length < minTrains) continue;
    const { spanFt, routes: lines, centroid } = clusterStats(members, { routeKey: (t) => t.line });
    if (lines.size < minLines) continue;
    if (stoppedRns) {
      const stopped = members.filter((t) => stoppedRns.has(t.rn)).length;
      if (stopped < minStopped) continue;
    }
    out.push({
      trains: members,
      lines: [...lines].sort(),
      lineCount: lines.size,
      spanFt: Math.round(spanFt),
      centroid,
    });
  }
  out.sort((a, b) =>
    a.trains.length !== b.trains.length ? b.trains.length - a.trains.length : a.spanFt - b.spanFt,
  );
  return out;
}

// Group a cluster's trains by line, each group sorted by rn, with a per-train
// disc number (1 = first listed). Returns { byLine: [{ line, rns:[{rn,n}] }],
// labels: Map<rn,n> } in line order (most trains first, tie-break line name).
function groupByLine(cluster) {
  const groups = new Map();
  for (const t of cluster.trains) {
    if (!groups.has(t.line)) groups.set(t.line, []);
    groups.get(t.line).push(t);
  }
  const ordered = [...groups.entries()]
    .map(([line, ts]) => ({
      line,
      trains: ts.sort((a, b) => String(a.rn).localeCompare(String(b.rn))),
    }))
    .sort((a, b) =>
      a.trains.length !== b.trains.length
        ? b.trains.length - a.trains.length
        : String(a.line).localeCompare(String(b.line)),
    );
  const labels = new Map();
  let n = 0;
  const byLine = ordered.map((g) => ({
    line: g.line,
    rns: g.trains.map((t) => {
      n += 1;
      labels.set(t.rn, n);
      return { rn: t.rn, n };
    }),
  }));
  return { byLine, labels };
}

module.exports = {
  detectCrossLineBunches,
  groupByLine,
  CROSS_RADIUS_FT,
  MIN_TRAINS,
  MIN_LINES,
  MIN_STOPPED,
};
