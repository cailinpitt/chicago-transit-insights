#!/usr/bin/env node
// One-off backfill for the schedule-anchored single-train cancellation columns
// (cancel_state / cancel_dep_ts / cancel_arr_ts / cancel_train_no / cancel_origin)
// on metra alert_posts rows captured before that lifecycle shipped.
//
// Those rows were marked ongoing until Metra dropped them from the feed — the very
// behavior the new lifecycle replaces. This reclassifies each metra alert that has
// no cancel_state yet by reconstructing a minimal alert shape from the stored row
// (headline + short_description + routes) and running classifyCancellationAlert
// against the current GTFS index, resolved on the alert's OWN service day (now =
// first_seen_ts) so a historical alert resolves to the right scheduled trip.
//
// For each that resolves to a single train: record the window (→ 'upcoming'), then
// finalize it if the scheduled departure is already in the past (almost always, for
// a backfill) — the same persist+finalize the bin applies live, but it never posts
// a close-note (the originals are long published). Alerts that don't resolve to one
// train (delays, open-ended notices) are left untouched on the ongoing→resolved
// model. Idempotent: only rows with cancel_state IS NULL are scanned. --dry-run
// previews without writing.

require('../src/shared/env');

const Path = require('node:path');
const Fs = require('node:fs');
const { getDb, recordCancellation, finalizeCancellation } = require('../src/shared/history');
const { classifyCancellationAlert } = require('../src/metra/cancellationAlert');
const { runBin } = require('../src/shared/runBin');

const DRY_RUN = process.argv.includes('--dry-run');

function loadIndex() {
  try {
    const p = Path.join(__dirname, '..', 'data', 'metra-gtfs', 'index.json');
    return JSON.parse(Fs.readFileSync(p, 'utf8'));
  } catch (_e) {
    return null;
  }
}

// Reconstruct the minimal alert the classifier needs from a stored row. We don't
// persist informed_entity trip ids, so the header train-number path does the work
// (it resolved every live annulment in calibration); route ids come from `routes`.
function alertFromRow(row) {
  const routeIds = (row.routes || '').split(',').filter(Boolean);
  return {
    id: row.alert_id,
    header: row.headline,
    description: row.short_description || null,
    informedEntities: routeIds.map((routeId) => ({ routeId, tripId: null })),
  };
}

async function main() {
  const db = getDb();
  const index = loadIndex();
  if (!index) {
    console.error(
      'backfill-metra-cancellations: schedule index missing — run fetch-metra-gtfs first',
    );
    process.exitCode = 1;
    return;
  }

  const rows = db
    .prepare(`
      SELECT alert_id, headline, short_description, routes, first_seen_ts
      FROM alert_posts
      WHERE kind = 'metra' AND cancel_state IS NULL
      ORDER BY first_seen_ts DESC
    `)
    .all();

  console.log(
    `backfill-metra-cancellations${DRY_RUN ? ' (DRY RUN)' : ''}: scanning ${rows.length} unclassified metra alerts`,
  );

  const now = Date.now();
  let upcoming = 0;
  let cancelled = 0;
  let skipped = 0;

  for (const row of rows) {
    const cancel = classifyCancellationAlert({
      alert: alertFromRow(row),
      index,
      now: row.first_seen_ts, // resolve on the alert's own service day
    });
    if (!cancel) {
      skipped += 1;
      continue;
    }
    const past = now >= cancel.scheduledDepMs;
    const label = `${cancel.route} #${cancel.trainNumber} dep ${new Date(cancel.scheduledDepMs).toISOString()}`;
    if (DRY_RUN) {
      console.log(
        `  would ${past ? 'finalize (cancelled)' : 'set upcoming'}: ${row.alert_id} — ${label}`,
      );
      if (past) cancelled += 1;
      else upcoming += 1;
      continue;
    }
    recordCancellation({
      alertId: row.alert_id,
      depTs: cancel.scheduledDepMs,
      arrTs: cancel.scheduledArrMs,
      trainNo: cancel.trainNumber,
      origin: cancel.origin,
    });
    if (past) {
      finalizeCancellation({ alertId: row.alert_id, replyUri: null });
      cancelled += 1;
    } else {
      upcoming += 1;
    }
    console.log(`  ${past ? 'cancelled' : 'upcoming'}: ${row.alert_id} — ${label}`);
  }

  console.log(
    `backfill-metra-cancellations: cancelled=${cancelled}, upcoming=${upcoming}, skipped(non-single-train)=${skipped}`,
  );
}

runBin(main);
