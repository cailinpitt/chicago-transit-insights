#!/usr/bin/env node
// Metra hourly service rollup — cancellations (Phase 2) + delays (Phase 3). The
// cron entry is named metra-cancellations for historical reasons; it now posts a
// single combined digest.
//
// Posting model (decided — see plan-6-9-26.md §4.1c): service issues are NOT
// posted per-trip in real time. Every cancellation and significant delay is
// recorded to disruption_events as website-data-first (posted=0), and this job —
// run hourly, like the CTA ghost rollups — posts ONE digest of the per-line
// counts seen in the last hour to the Metra alerts account. Silent when there's
// nothing. There is deliberately no per-incident thread/clear machinery: the post
// is a fire-and-forget summary; the website is the full record.
//
// Three signals:
//   - confirmed cancellation — Metra flagged the trip CANCELED. Authoritative.
//   - inferred cancellation  — a scheduled trip departed with no train ever seen
//     and no flag. Feed-health-gated; framed as unconfirmed.
//   - delay — a running train that hit the delay threshold (15+ min) this hour;
//     delay = predicted − scheduled, already captured per tick in
//     metra_trip_updates. The Metra analog of CTA gaps.

require('../../src/shared/env');

const Path = require('node:path');
const Fs = require('node:fs');

const { setup, runBin } = require('../../src/shared/runBin');
const { detectCancellations, isFeedHealthy } = require('../../src/metra/cancellations');
const {
  computeMaxDelays,
  significantDelays,
  DELAY_THRESHOLD_SEC,
} = require('../../src/metra/delays');
const {
  scheduledDeparturesInWindow,
  chicagoDateStr,
  chicagoMidnightMs,
  tripKey,
} = require('../../src/metra/schedule');
const { getMetraAlerts } = require('../../src/metra/api');
const { lineLabel, LINE_NAMES } = require('../../src/metra/lines');
const { loginMetraAlerts, postText } = require('../../src/metra/bluesky');
const {
  getMetraCanceledTrips,
  getMetraObservedTripIds,
  getMetraLivePredictionTripIds,
  getMetraLatestPredictions,
  getMetraSnapshotTimestamps,
} = require('../../src/shared/observations');
const { recordDisruption, getMetraRecordedTripIds } = require('../../src/shared/history');
const { formatTimeCT } = require('../../src/shared/format');

const DRY_RUN = process.env.METRA_DRY_RUN === '1' || process.argv.includes('--dry-run');

// The rollup reports "the last hour"; the window is slightly wider so a late
// cron tick doesn't drop cancellations between runs (dedup keeps overlap safe).
const ROLLUP_WINDOW_MS = 70 * 60 * 1000;
const DAY_LOOKBACK_MS = 20 * 60 * 60 * 1000; // "ran at all today" / schedule span
const GRACE_MS = 15 * 60 * 1000;

function loadIndex() {
  try {
    const p = Path.join(__dirname, '..', '..', 'data', 'metra-gtfs', 'index.json');
    return JSON.parse(Fs.readFileSync(p, 'utf8'));
  } catch (_e) {
    return null;
  }
}

function depLabel(ms) {
  return ms ? formatTimeCT(new Date(ms)) : null;
}

// Build the evidence + segment fields for a disruption_events row from an
// enriched event record (a cancellation or a delay — its `source` decides the
// evidence shape). Resolves stop ids to names via the index.
function toDisruption(event, index) {
  const stops = index?.stops || {};
  const origin = event.originStopId ? stops[event.originStopId]?.name || null : null;
  const dest = event.headsign || (event.destStopId ? stops[event.destStopId]?.name || null : null);
  const evidence = {
    tripId: event.tripId,
    serviceDate: event.serviceDate,
    scheduledDepTs: event.scheduledDepMs ?? null,
    scheduledDepLabel: depLabel(event.scheduledDepMs),
    headsign: event.headsign ?? null,
    origin,
  };
  if (event.source === 'delay') {
    evidence.delaySec = event.delaySec ?? null;
    evidence.delayMin = event.delayMin ?? null;
  } else {
    evidence.inferred = event.source === 'cancellation-inferred';
  }
  return {
    kind: 'metra',
    line: event.route,
    direction: event.directionId != null ? String(event.directionId) : null,
    fromStation: origin,
    toStation: dest,
    source: event.source,
    posted: 0,
    evidence,
  };
}

// "BNSF 2 · UP-N 1" sorted by count desc then line order, capped so a system-wide
// bad hour can't blow the 300-grapheme post limit.
function tally(events, maxItems = 8) {
  const counts = new Map();
  for (const e of events) counts.set(e.route, (counts.get(e.route) || 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = sorted.slice(0, maxItems).map(([route, n]) => `${LINE_NAMES[route] || route} ${n}`);
  if (sorted.length > maxItems) shown.push(`+${sorted.length - maxItems} more`);
  return shown.join(' · ');
}

// One hourly digest covering cancellations + delays. Each non-empty category gets
// one line; the bin only posts when at least one category has events.
function buildRollupText(confirmed, inferred, delays) {
  const lines = ['🚆 Metra service · last hour', ''];
  if (confirmed.length > 0) lines.push(`❌ Cancelled: ${tally(confirmed)}`);
  if (inferred.length > 0) {
    lines.push(`⚠️ Scheduled but not seen running (unconfirmed): ${tally(inferred)}`);
  }
  if (delays.length > 0) lines.push(`🐌 15+ min late: ${tally(delays)}`);
  lines.push('');
  lines.push('Per Metra realtime data.');
  return lines.join('\n');
}

async function fetchAlertCoveredTripIds() {
  try {
    const alerts = await getMetraAlerts();
    const set = new Set();
    for (const a of alerts) {
      for (const e of a.informedEntities || []) if (e.tripId) set.add(e.tripId);
    }
    return set;
  } catch (e) {
    console.warn(
      `metra cancellations: alert fetch failed (${e.message}); continuing without alert cover`,
    );
    return new Set();
  }
}

async function main() {
  setup();
  const now = Date.now();
  const index = loadIndex();
  if (!index) {
    console.error('metra cancellations: schedule index missing — run fetch-metra-gtfs first');
    return;
  }

  // Schedule: every trip whose departure lands across the service day, mapped by
  // trip_id (enriches confirmed cancellations); the recent slice is the inferred
  // candidate pool.
  const allTrips = scheduledDeparturesInWindow(
    index,
    now - DAY_LOOKBACK_MS,
    now + 2 * 60 * 60 * 1000,
    now,
  );
  // Keyed by the suffix-agnostic trip key so realtime ids (which carry a
  // different service suffix than the static index) resolve to their schedule.
  const tripByKey = new Map(allTrips.map((t) => [tripKey(t.tripId), t]));
  const candidateTrips = allTrips.filter(
    (t) => t.scheduledDepMs >= now - ROLLUP_WINDOW_MS - GRACE_MS,
  );
  // Merge a raw realtime event ({tripId, route, …}) with its static schedule
  // record (headsign, scheduled departure, origin/dest, direction) via the trip
  // key; the raw fields (e.g. delaySec) win. Falls back to the raw event alone.
  const enrich = (raw) => {
    const base = tripByKey.get(tripKey(raw.tripId));
    return base ? { ...base, ...raw } : { serviceDate: chicagoDateStr(now), ...raw };
  };

  // Confirmed cancellations Metra flagged in the window, enriched from the index.
  const canceledTrips = getMetraCanceledTrips(now - ROLLUP_WINDOW_MS).map(enrich);

  // Context sets, normalized into the suffix-agnostic key space (the live feed
  // tags trips with a different service suffix than the static index — see
  // schedule.js#tripKey), or every scheduled train reads as unobserved.
  const keys = (set) => new Set([...set].map(tripKey));
  const observedTripIds = keys(getMetraObservedTripIds(now - DAY_LOOKBACK_MS));
  const livePredictionTripIds = keys(getMetraLivePredictionTripIds(now - DAY_LOOKBACK_MS));
  const alertCoveredTripIds = keys(await fetchAlertCoveredTripIds());
  const feedHealthy = isFeedHealthy(getMetraSnapshotTimestamps(now - 30 * 60 * 1000), now);
  if (!feedHealthy) {
    console.warn('metra cancellations: feed unhealthy — inferred layer suppressed this run');
  }

  const { confirmed, inferred } = detectCancellations({
    canceledTrips,
    candidateTrips,
    observedTripIds,
    livePredictionTripIds,
    alertCoveredTripIds,
    now,
    graceMs: GRACE_MS,
    feedHealthy,
    keyOf: tripKey,
  });

  // Delays: trains that hit 15+ min late this hour. Metra's feed delay field is
  // always 0, so we compute delay = predicted − scheduled ourselves. The resolver
  // maps a realtime (trip, stop) to its scheduled arrival POSIX via the static
  // index (trip matched suffix-agnostically; stop by id; serviceDate → midnight).
  const scheduledArrFor = (rtTripId, stopId) => {
    const rec = tripByKey.get(tripKey(rtTripId));
    if (!rec) return null;
    const staticTrip = index.trips[rec.tripId];
    const st = staticTrip?.stop_times?.find((s) => s.stop_id === stopId);
    if (st?.arrival == null) return null;
    return chicagoMidnightMs(rec.serviceDate) / 1000 + st.arrival;
  };
  const maxDelays = computeMaxDelays(
    getMetraLatestPredictions(now - ROLLUP_WINDOW_MS),
    scheduledArrFor,
  );
  const delaysDetected = significantDelays(maxDelays);

  // Dedup against what's already been recorded for the relevant service dates, so
  // an event logged on an earlier hourly run isn't recorded or counted twice.
  // Cancellations and delays dedup against their own source buckets.
  const serviceDates = new Set(
    candidateTrips.map((t) => t.serviceDate).concat(chicagoDateStr(now)),
  );
  const recordedKeys = (sources) => {
    const set = new Set();
    for (const d of serviceDates)
      for (const id of getMetraRecordedTripIds(d, sources)) set.add(tripKey(id));
    return set;
  };
  const recordedCx = recordedKeys(['cancellation', 'cancellation-inferred']);
  const recordedDelay = recordedKeys(['delay']);
  const newConfirmed = confirmed.filter((t) => !recordedCx.has(tripKey(t.tripId)));
  const newInferred = inferred.filter((t) => !recordedCx.has(tripKey(t.tripId)));
  const newDelays = delaysDetected.filter((d) => !recordedDelay.has(tripKey(d.tripId))).map(enrich);

  console.log(
    `metra service rollup: ${newConfirmed.length} confirmed, ${newInferred.length} inferred, ${newDelays.length} delayed (≥${DELAY_THRESHOLD_SEC / 60}min) (feed ${feedHealthy ? 'healthy' : 'STALE'})`,
  );

  const all = [...newConfirmed, ...newInferred, ...newDelays];

  if (DRY_RUN) {
    for (const t of all) {
      const detail =
        t.source === 'delay'
          ? `~${t.delayMin}min late`
          : `dep ${depLabel(t.scheduledDepMs) || '?'}`;
      console.log(
        `  [${t.source}] ${lineLabel(t.route)} ${t.tripId} ${detail} → ${t.headsign || '?'}`,
      );
    }
    const text =
      all.length > 0
        ? buildRollupText(newConfirmed, newInferred, newDelays)
        : '(silent — nothing this hour)';
    console.log(`\n--- DRY RUN rollup (DB write skipped) ---\n${text}`);
    return;
  }

  // Record every new event (website-data-first), then post the digest.
  for (const t of all) recordDisruption(toDisruption(t, index), now);

  if (all.length === 0) {
    console.log('metra service rollup: nothing this hour — staying silent');
    return;
  }

  const text = buildRollupText(newConfirmed, newInferred, newDelays);
  const agent = await loginMetraAlerts();
  const result = await postText(agent, text);
  console.log(`Posted metra service rollup: ${result.url}`);
}

if (require.main === module) {
  runBin(main);
}

module.exports = { buildRollupText, tally, toDisruption };
