const { haversineFt } = require('../shared/geo');

const BUNCHING_THRESHOLD_FT = 800; // ~2.5 Chicago city blocks
const STALE_MS = 3 * 60 * 1000;
const TERMINAL_PDIST_FT = 500; // start-terminal layovers, not real bunching
// Geographic straight-line distance is bounded by along-route distance, so any
// excess over pdist span means CTA's pdist is stale/wrong (e.g. a bus that just
// laid over and is starting a new run before pdist refreshes). Slack covers GPS
// jitter and minor route curvature against the chord.
const GEO_SLACK_FT = 500;

// Returns clusters ranked best-first by size desc, then max-gap asc — the
// caller picks the first whose pid isn't on cooldown.
function detectAllBunching(vehicles, now = new Date()) {
  const fresh = vehicles.filter((v) => now - v.tmstmp < STALE_MS);

  const byPid = new Map();
  for (const v of fresh) {
    if (!byPid.has(v.pid)) byPid.set(v.pid, []);
    byPid.get(v.pid).push(v);
  }

  const bunches = [];
  for (const [pid, group] of byPid) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.pdist - b.pdist);

    let i = 0;
    while (i < sorted.length - 1) {
      if (sorted[i + 1].pdist - sorted[i].pdist > BUNCHING_THRESHOLD_FT) {
        i++;
        continue;
      }
      let j = i + 1;
      let maxGap = sorted[j].pdist - sorted[i].pdist;
      while (
        j + 1 < sorted.length &&
        sorted[j + 1].pdist - sorted[j].pdist <= BUNCHING_THRESHOLD_FT
      ) {
        maxGap = Math.max(maxGap, sorted[j + 1].pdist - sorted[j].pdist);
        j++;
      }
      const cluster = sorted.slice(i, j + 1);
      if (cluster[0].pdist < TERMINAL_PDIST_FT) {
        i = j + 1;
        continue;
      }
      const pdistSpan = cluster[cluster.length - 1].pdist - cluster[0].pdist;
      let geoSpan = 0;
      for (let a = 0; a < cluster.length; a++) {
        for (let b = a + 1; b < cluster.length; b++) {
          const d = haversineFt(cluster[a], cluster[b]);
          if (d > geoSpan) geoSpan = d;
        }
      }
      if (geoSpan > pdistSpan + GEO_SLACK_FT) {
        i = j + 1;
        continue;
      }
      bunches.push({
        pid,
        route: cluster[0].route,
        vehicles: cluster,
        maxGapFt: maxGap,
        spanFt: cluster[cluster.length - 1].pdist - cluster[0].pdist,
      });
      i = j + 1;
    }
  }

  // More buses → more severe; tie-break on tighter max gap.
  bunches.sort((a, b) => {
    if (a.vehicles.length !== b.vehicles.length) return b.vehicles.length - a.vehicles.length;
    return a.maxGapFt - b.maxGapFt;
  });

  return bunches;
}

function detectBunching(vehicles, now = new Date()) {
  const all = detectAllBunching(vehicles, now);
  return all[0] || null;
}

// The rider-facing cost of a bunch is the gap it leaves behind it. Find the
// nearest bus following the bunch on the same pattern and report how far back
// it is (and, if a scheduled trip time is known, roughly how long until it
// arrives at scheduled pace). Returns null when nothing is following — the
// bunch is the back of the line, so there's no trailing gap to describe.
function computeGapBehind({ vehicles, pid, bunchVehicles, lengthFt, tripMinutes }) {
  const bunchVids = new Set(bunchVehicles.map((v) => v.vid));
  const trailingPdist = Math.min(...bunchVehicles.map((v) => parseFloat(v.pdist)));
  let follower = null;
  for (const v of vehicles) {
    if (v.pid !== pid || bunchVids.has(v.vid)) continue;
    const pdist = parseFloat(v.pdist);
    if (!Number.isFinite(pdist) || pdist >= trailingPdist) continue;
    if (!follower || pdist > follower.pdist) follower = { vid: v.vid, pdist };
  }
  if (!follower) return null;
  const distFt = Math.round(trailingPdist - follower.pdist);
  const minutes =
    lengthFt > 0 && tripMinutes > 0 ? Math.round((distFt / lengthFt) * tripMinutes) : null;
  return { distFt, minutes, followerVid: follower.vid };
}

module.exports = { detectAllBunching, detectBunching, computeGapBehind, BUNCHING_THRESHOLD_FT };
