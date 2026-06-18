// Cross-route bus bunching — a pileup at one spot involving 2+ routes
// (e.g. 2 #22 + 3 #36 stacked at Clark & Belmont). The per-pattern detector in
// bunching.js can't see this: each route's pdist is a separate coordinate
// system, so it never compares a #22 against a #36. Here we cluster purely on
// geography (lat/lon) across ALL routes, then require the cluster to span 2+
// routes and show congestion.
const { clusterByProximity, clusterStats } = require('../shared/geoClusters');

const CROSS_RADIUS_FT = 660; // ~2 city blocks — an intersection + its approaches
const MIN_VEHICLES = 3; // a pileup, not just one bus meeting another
const MIN_ROUTES = 2; // the whole point: distinct routes, else regular bunching catches it
const MIN_STOPPED = 2; // congestion evidence — real pileup, not vehicles crossing in motion
const STALE_MS = 3 * 60 * 1000;

// `vehicles` carry { vid, route, lat, lon, tmstmp }. `stoppedIds` is a Set of
// vids the caller has confirmed barely-moving (findParkedBusVids) — the
// congestion gate. Omit it to detect on geometry alone (tests / diagnostics).
// Returns clusters best-first: most vehicles, tie-break tightest span.
function detectCrossRouteBunches(
  vehicles,
  {
    now = Date.now(),
    stoppedIds = null,
    radiusFt = CROSS_RADIUS_FT,
    minVehicles = MIN_VEHICLES,
    minRoutes = MIN_ROUTES,
    minStopped = MIN_STOPPED,
  } = {},
) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const fresh = (vehicles || []).filter((v) => {
    const ts = v?.tmstmp instanceof Date ? v.tmstmp.getTime() : v?.tmstmp;
    return (
      Number.isFinite(v?.lat) &&
      Number.isFinite(v?.lon) &&
      Number.isFinite(ts) &&
      nowMs - ts < STALE_MS
    );
  });

  const out = [];
  for (const members of clusterByProximity(fresh, { radiusFt })) {
    if (members.length < minVehicles) continue;
    const { spanFt, routes, centroid } = clusterStats(members, { routeKey: (v) => v.route });
    if (routes.size < minRoutes) continue;
    if (stoppedIds) {
      const stopped = members.filter((v) => stoppedIds.has(v.vid)).length;
      if (stopped < minStopped) continue;
    }
    out.push({
      vehicles: members,
      routes: [...routes].sort(),
      routeCount: routes.size,
      spanFt: Math.round(spanFt),
      centroid,
    });
  }
  out.sort((a, b) =>
    a.vehicles.length !== b.vehicles.length
      ? b.vehicles.length - a.vehicles.length
      : a.spanFt - b.spanFt,
  );
  return out;
}

// Group a cluster's vehicles by route, each group sorted by vid, with a per-bus
// disc number (1 = first listed) for the map + post. Returns
// { byRoute: [{ route, vids:[{vid,n}] }], labels: Map<vid,n> } in route order
// (most vehicles first, tie-break route name).
function groupByRoute(cluster) {
  const groups = new Map();
  for (const v of cluster.vehicles) {
    if (!groups.has(v.route)) groups.set(v.route, []);
    groups.get(v.route).push(v);
  }
  const ordered = [...groups.entries()]
    .map(([route, vs]) => ({
      route,
      vehicles: vs.sort((a, b) => String(a.vid).localeCompare(String(b.vid))),
    }))
    .sort((a, b) =>
      a.vehicles.length !== b.vehicles.length
        ? b.vehicles.length - a.vehicles.length
        : String(a.route).localeCompare(String(b.route)),
    );
  const labels = new Map();
  let n = 0;
  const byRoute = ordered.map((g) => ({
    route: g.route,
    vids: g.vehicles.map((v) => {
      n += 1;
      labels.set(v.vid, n);
      return { vid: v.vid, n };
    }),
  }));
  return { byRoute, labels };
}

module.exports = {
  detectCrossRouteBunches,
  groupByRoute,
  CROSS_RADIUS_FT,
  MIN_VEHICLES,
  MIN_ROUTES,
  MIN_STOPPED,
};
