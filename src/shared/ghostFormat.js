// Shared count + effective-headway phrasing for ghost rollup lines (bus and
// train). Everything is derived from the SAME rounded integers so the "X of Y
// missing" and the headway can never disagree: the old code took the percentage
// from rounded counts but the headway from the raw fractional ratio, so "4 of 9"
// could sit next to a headway computed from 5.5 observed (reading ~16 when
// 4-of-9 implies ~18). The effective headway is floored at the scheduled
// headway — a route/line that's missing service is never running *better* than
// the schedule.
//
//   expectedActive — scheduled trips simultaneously active this hour (GTFS)
//   observed       — the service level to display. Buses pass the parked-
//                    filtered, recent-window count; trains pass observedActive.
//   headway        — scheduled headway (min), or null mid-coverage hours.
function describeGhost({ expectedActive, observed, headway }) {
  const expectedShown = Math.round(expectedActive);
  const missingShown = Math.round(expectedActive - observed);
  const pct = expectedShown > 0 ? Math.round((missingShown / expectedShown) * 100) : 0;
  if (headway == null) return { expectedShown, missingShown, pct, headwayPhrase: null };
  const scheduledHeadway = Math.round(headway);
  const runningShown = Math.max(expectedShown - missingShown, 1);
  const ratio = expectedShown / runningShown;
  // Above 3× scheduled the effective-headway number explodes into noise — fall
  // back to just naming the scheduled cadence.
  const headwayPhrase =
    ratio > 3
      ? `scheduled every ~${scheduledHeadway} min`
      : `every ~${Math.max(scheduledHeadway, Math.round(scheduledHeadway * ratio))} min instead of ~${scheduledHeadway}`;
  return { expectedShown, missingShown, pct, headwayPhrase };
}

module.exports = { describeGhost };
