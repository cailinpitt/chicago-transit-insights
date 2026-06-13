// Compares observed active bus count against the scheduled active-trip count
// per hour. The ground-truth number of buses that should be simultaneously
// active per direction.

const MISSING_PCT_THRESHOLD = 0.25;
const MISSING_ABS_THRESHOLD = 3;
// When the deficit is concentrated in the trailing window slice we can lower
// the absolute threshold — mid-hour incidents don't get a full hour to
// accumulate evidence.
const MISSING_ABS_THRESHOLD_TRAILING = 2;
const TRAILING_DEFICIT_MIN = 2;
const MIN_SNAPSHOTS = 4; // observe-buses runs */10 → ~6 polls/hour; 4 tolerates 2 drops
const MIN_OBSERVED = 2; // observed=0/1 is either a schedule bug or a gap (already covered)
const MAX_EXPECTED_ACTIVE = 30; // sanity ceiling — most likely a bad GTFS bucket
const RAMP_FILL_RATIO = 0.8; // tail median ≥ this × expected → pipeline is filling, not ghosting
const RAMP_TAIL_FRACTION = 0.25; // tail = last 25%, min 3

const { median } = require('../shared/stats');
const { findParkedBusVids, PARKED_WINDOW_MS } = require('./bunching');

// During AM ramp-up the full-window median lags reality but the tail tracks
// current service — used to gate against firing on a filling pipeline.
function tailMedian(perSnapshot) {
  const pairs = [...perSnapshot.entries()].sort((a, b) => a[0] - b[0]);
  const tailLen = Math.max(3, Math.ceil(pairs.length * RAMP_TAIL_FRACTION));
  const tail = pairs.slice(-tailLen).map(([, set]) => set.size);
  return median(tail);
}

async function detectBusGhosts({
  routes,
  getObservations,
  getPattern,
  expectedHeadway,
  expectedDuration,
  expectedActive,
  onDrop,
}) {
  const events = [];
  const drop = (reason, info) => {
    if (onDrop) onDrop({ reason, ...info });
  };

  for (const route of routes) {
    const obs = getObservations(route);
    if (obs.length === 0) {
      drop('no_observations', { route });
      continue;
    }

    // Confirmed-parked buses (barely moved over the last ~5 min) shouldn't count
    // as service in the *displayed* headway — a dead/laid-over bus broadcasting
    // on the route otherwise inflates "observed" and makes the gap read better
    // than the street feels. Route-wide set over the recent window; firing
    // counts deliberately ignore this (a bus that ran most of the hour then died
    // still served most of the hour). Safe no-op when obs lack pdist.
    const maxTs = obs.reduce((m, o) => (o.ts > m ? o.ts : m), 0);
    const parkedVids = findParkedBusVids(obs.filter((o) => o.ts >= maxTs - PARKED_WINDOW_MS));

    // Skip the whole route on any pattern resolution failure — expectedActive
    // still counts trips for that pid, so dropping observations alone would
    // inflate `missing` and fire a spurious ghost.
    const pids = [...new Set(obs.map((o) => o.direction).filter(Boolean))];
    const patternByPid = new Map();
    const failedPids = [];
    for (const pid of pids) {
      try {
        const p = await getPattern(pid);
        if (p?.direction) patternByPid.set(pid, p);
        else failedPids.push(pid);
      } catch (e) {
        failedPids.push(pid);
        console.warn(`ghosts: pattern fetch failed for pid ${pid}: ${e.message}`);
      }
    }
    if (failedPids.length > 0) {
      console.warn(
        `ghosts: skipping route ${route} — unresolved pids with observations: ${failedPids.join(', ')}`,
      );
      drop('pattern_fetch_failed', { route, failedPids });
      continue;
    }

    // Group by rider-facing direction label so weekday/express pid variants merge.
    const byDir = new Map();
    for (const o of obs) {
      const pattern = patternByPid.get(o.direction);
      if (!pattern) continue;
      const label = pattern.direction;
      if (!byDir.has(label)) byDir.set(label, { obs: [], pattern });
      byDir.get(label).obs.push(o);
    }

    for (const [direction, group] of byDir) {
      const ctx = { route, direction };
      const headway = expectedHeadway(route, group.pattern);
      const duration = expectedDuration(route, group.pattern);
      const active = expectedActive(route, group.pattern);
      if (active == null || active <= 0) {
        drop('no_schedule', { ...ctx, expectedActive: active });
        continue;
      }
      // Headway/duration are display-only — null falls back to generic wording.

      // Sparse routes (active < 2) make ghost calls meaningless; one missing
      // bus isn't a story, two→zero is a gap (covered by the gaps bot).
      if (active < 2) {
        drop('sparse_route', { ...ctx, expectedActive: active });
        continue;
      }
      if (active > MAX_EXPECTED_ACTIVE) {
        console.warn(
          `ghosts: ${route}/${direction} expectedActive=${active.toFixed(1)} exceeds cap (${MAX_EXPECTED_ACTIVE}) — skipping, likely schedule-index bug`,
        );
        drop('expected_cap_exceeded', { ...ctx, expectedActive: active });
        continue;
      }

      const perSnapshot = new Map();
      for (const o of group.obs) {
        if (!perSnapshot.has(o.ts)) perSnapshot.set(o.ts, new Set());
        perSnapshot.get(o.ts).add(o.vehicle_id);
      }
      if (perSnapshot.size < MIN_SNAPSHOTS) {
        drop('too_few_snapshots', { ...ctx, snapshots: perSnapshot.size, expectedActive: active });
        continue;
      }

      const counts = [...perSnapshot.values()].map((s) => s.size);
      const observedActive = median(counts);
      const missing = active - observedActive;
      const detail = {
        ...ctx,
        expectedActive: active,
        observedActive,
        missing,
        snapshots: perSnapshot.size,
      };
      if (missing < MISSING_ABS_THRESHOLD) {
        const tailMed = tailMedian(perSnapshot);
        const trailingDeficit = active - tailMed;
        // Override requires the deficit to be CONCENTRATED in the tail —
        // full-window observed must exceed tail observed, indicating a
        // mid-incident drop rather than steady under-counting.
        if (
          missing >= MISSING_ABS_THRESHOLD_TRAILING &&
          trailingDeficit >= TRAILING_DEFICIT_MIN &&
          tailMed < observedActive
        ) {
          // Trailing-deficit override admits.
        } else {
          drop('below_abs_threshold', detail);
          continue;
        }
      }
      if (missing / active < MISSING_PCT_THRESHOLD) {
        drop('below_pct_threshold', detail);
        continue;
      }
      if (observedActive < MIN_OBSERVED) {
        drop('too_few_observed', detail);
        continue;
      }
      // Wildly inconsistent counts usually indicate polling blackouts, not real ghosts.
      const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
      const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
      const stddev = Math.sqrt(variance);
      if (stddev > observedActive) {
        drop('noisy_polling', { ...detail, stddev });
        continue;
      }
      // Ramp-up gate: a filled tail means the deficit is at the front of the
      // hour, not now. Real outages persist into the tail.
      const tail = tailMedian(perSnapshot);
      if (tail >= RAMP_FILL_RATIO * active) {
        drop('ramp_up_filled', { ...detail, tailMedian: tail });
        continue;
      }

      // Displayed service level: the parked-filtered count over the recent
      // (tail) window, so a worsening outage and dead buses both read as bad as
      // they currently are. Drives the post's "X of Y" + headway; firing above
      // still uses the full-window, unfiltered observedActive for stability.
      const sortedSnaps = [...perSnapshot.entries()].sort((a, b) => a[0] - b[0]);
      const tailLen = Math.max(3, Math.ceil(sortedSnaps.length * RAMP_TAIL_FRACTION));
      const displayCounts = sortedSnaps.slice(-tailLen).map(([, set]) => {
        let n = 0;
        for (const v of set) if (!parkedVids.has(v)) n++;
        return n;
      });
      const observedDisplay = median(displayCounts);

      events.push({
        route,
        direction,
        expectedActive: active,
        observedActive,
        observedDisplay,
        missing,
        snapshots: perSnapshot.size,
        headway,
        duration,
      });
    }
  }

  events.sort((a, b) => b.missing - a.missing);
  return events;
}

module.exports = {
  detectBusGhosts,
  MISSING_PCT_THRESHOLD,
  MISSING_ABS_THRESHOLD,
  MISSING_ABS_THRESHOLD_TRAILING,
  TRAILING_DEFICIT_MIN,
  MIN_SNAPSHOTS,
  MIN_OBSERVED,
  MAX_EXPECTED_ACTIVE,
  RAMP_FILL_RATIO,
  RAMP_TAIL_FRACTION,
};
