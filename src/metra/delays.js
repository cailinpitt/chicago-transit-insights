// Metra delay detection — the analog of CTA "gaps", reframed for a timetabled
// railroad. On a clockface schedule the rider-facing number is "how late is my
// train": delay = predicted − scheduled arrival.
//
// IMPORTANT: Metra sends `StopTimeEvent.delay = 0` on every update (verified
// 2026-06-09 — 36k rows, all zero), so we CAN'T read delay off the feed. But it
// DOES send concrete predicted arrival times (`predicted_arr`), so we compute the
// delay ourselves against the static schedule. observeMetra already records the
// predictions every tick; this module works over them. Pure + injected so it's
// unit-testable.

// A Metra train is "significantly late" at 15+ min. Metra's own on-time bar is
// < 6 min at the terminal, but posting every 6-min-late train would be constant
// noise — 15 min is clearly newsworthy and keeps the rollup quiet on normal days.
// Tunable; calibrate against a shadow week.
const DELAY_THRESHOLD_SEC = 15 * 60;

// Each trip's worst delay (seconds) from its latest per-stop arrival predictions.
//   predictionRows: [{ tripId, route, stopId, predictedArr }]  (predictedArr = POSIX seconds)
//   scheduledArrFor(tripId, stopId): scheduled arrival POSIX seconds, or null if unknown
// A train running 20 min late predicts ~20 min late at each of its upcoming stops,
// so the max across its stops is a robust estimate of its current lateness.
function computeMaxDelays(predictionRows, scheduledArrFor) {
  const byTrip = new Map();
  for (const r of predictionRows) {
    if (r.predictedArr == null) continue;
    const sched = scheduledArrFor(r.tripId, r.stopId);
    if (sched == null) continue;
    const delay = r.predictedArr - sched;
    const cur = byTrip.get(r.tripId);
    if (!cur || delay > cur.maxDelay) {
      byTrip.set(r.tripId, { tripId: r.tripId, route: r.route, maxDelay: delay });
    }
  }
  return [...byTrip.values()];
}

// Filter per-trip max-delay rows to the significant ones, worst-first. Each event
// carries delaySec + delayMin for the post + evidence.
function significantDelays(rows, thresholdSec = DELAY_THRESHOLD_SEC) {
  return rows
    .filter((r) => Number.isFinite(r.maxDelay) && r.maxDelay >= thresholdSec)
    .map((r) => ({
      tripId: r.tripId,
      route: r.route,
      delaySec: r.maxDelay,
      delayMin: Math.round(r.maxDelay / 60),
      source: 'delay',
    }))
    .sort((a, b) => b.delaySec - a.delaySec);
}

module.exports = { computeMaxDelays, significantDelays, DELAY_THRESHOLD_SEC };
