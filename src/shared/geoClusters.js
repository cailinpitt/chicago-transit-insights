// Geographic clustering primitive — the substrate for cross-route bunching.
//
// Every along-route detector (src/{bus,train}/bunching.js) groups by a single
// pattern/line and measures distance ALONG that route. That can't see a pileup
// where vehicles from *different* routes converge on one spot — a #22 at
// pdist 12,000 and a #36 at pdist 3,000 can sit at the same corner, but their
// pdists live in different coordinate systems. Cross-route bunching is therefore
// purely geographic: cluster raw lat/lon across all vehicles, then require the
// cluster to span 2+ routes.
//
// Generic over any item exposing { lat, lon }; callers supply route/id accessors.
const { haversineFt } = require('./geo');

const DEFAULT_RADIUS_FT = 660; // ~2 Chicago blocks — an intersection + its approaches

// Connected-components ("single-link") clustering: two items are linked when
// within radiusFt; a cluster is a maximal linked group. O(n^2) over a snapshot
// of a few hundred vehicles — trivial. Items missing a finite lat/lon are
// dropped. Returns an array of clusters, each an array of the original items.
function clusterByProximity(items, { radiusFt = DEFAULT_RADIUS_FT } = {}) {
  const pts = (items || []).filter((it) => Number.isFinite(it?.lat) && Number.isFinite(it?.lon));
  const n = pts.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const next = parent[x];
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (haversineFt(pts[i], pts[j]) <= radiusFt) union(i, j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(pts[i]);
  }
  return [...groups.values()];
}

// Summary stats for a cluster: the widest pairwise gap (spanFt), the set of
// distinct route/line values, and the centroid (where to center the map).
function clusterStats(items, { routeKey = (x) => x.route } = {}) {
  let spanFt = 0;
  for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
      const d = haversineFt(items[a], items[b]);
      if (d > spanFt) spanFt = d;
    }
  }
  const routes = new Set(items.map(routeKey));
  const lat = items.reduce((s, v) => s + v.lat, 0) / items.length;
  const lon = items.reduce((s, v) => s + v.lon, 0) / items.length;
  return { spanFt, routes, centroid: { lat, lon } };
}

module.exports = { clusterByProximity, clusterStats, DEFAULT_RADIUS_FT };
