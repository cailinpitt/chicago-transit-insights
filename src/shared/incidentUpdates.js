// Hourly progress updates for long-running absence incidents.
//
// Thin-service gaps and pulse blackouts post one opening alert and one clear
// reply, with nothing in between — so a multi-hour outage gives a rider no sense
// of WHY it's still open. This module posts a threaded "still no service — ~Nh
// in" reply once an hour while the incident remains open, and records it into
// the permanent `incident_updates` archive so the event page keeps the timeline.
//
// The text/evidence builders are pure so the live detector bins and the backfill
// (bin/backfill-incident-updates.js) render identical updates; `sweepProgressUpdates`
// is the shared orchestration each bin calls after its clear pass, reusing the
// detector's own Bluesky account.
const history = require('./history');
const { resolveReplyRef, postText } = require('./bluesky');

// Effective hourly cadence. The bins tick faster; the 55-min gate collapses that
// to ~one update per clock hour while tolerating cron jitter.
const DEFAULT_MIN_INTERVAL_MS = 55 * 60 * 1000;
// Don't update right on the heels of the opening post; wait until the incident
// has been open ~an hour so the first update is a genuine "still going" beat.
const DEFAULT_MIN_AGE_MS = 55 * 60 * 1000;
// Reply window: past 24h the original thread is too cold for a fresh reply.
const DEFAULT_REPLY_LOOKBACK_MS = 24 * 60 * 60 * 1000;

function dueForUpdate({
  openedTs,
  lastUpdateTs,
  now,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  minAgeMs = DEFAULT_MIN_AGE_MS,
}) {
  if (openedTs == null) return false;
  if (now - openedTs < minAgeMs) return false;
  const since = lastUpdateTs ?? openedTs;
  return now - since >= minIntervalMs;
}

// "~3h" / "~45 min" — coarse on purpose; updates land hourly.
function formatElapsed(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  if (minutes >= 60) return `~${Math.round(minutes / 60)}h`;
  return `~${Math.round(minutes)} min`;
}

// --- Pure per-type builders → { description, evidence } (or null to skip) ---

function thinGapUpdate({ routeTitle, headwayMin, elapsedMin }) {
  const elapsed = formatElapsed(elapsedMin);
  if (!elapsed) return null;
  const missed =
    Number.isFinite(headwayMin) && headwayMin > 0 ? Math.floor(elapsedMin / headwayMin) : null;
  const missedClause = missed && missed >= 1 ? `, ~${missed} scheduled trips missed so far` : '';
  return {
    description: `🚌 ${routeTitle} · still no buses observed — ${elapsed} in${missedClause}.`,
    evidence: {
      elapsedMin: Math.round(elapsedMin),
      headwayMin: headwayMin ?? null,
      missedTrips: missed,
    },
  };
}

function busPulseUpdate({ routeTitle, expectedActive, elapsedMin }) {
  const elapsed = formatElapsed(elapsedMin);
  if (!elapsed) return null;
  const expected = Number.isFinite(expectedActive) ? Math.round(expectedActive) : null;
  const expectedClause =
    expected && expected >= 1 ? `; ~${expected} buses normally running this time` : '';
  return {
    description: `🚌 ${routeTitle} · service still appears suspended — ${elapsed} in${expectedClause}.`,
    evidence: { elapsedMin: Math.round(elapsedMin), expectedActive: expected },
  };
}

function trainPulseUpdate({
  lineTitle,
  fromStation,
  toStation,
  expectedTrains,
  elapsedMin,
  synthetic,
}) {
  const elapsed = formatElapsed(elapsedMin);
  if (!elapsed) return null;
  const where =
    !synthetic && fromStation && toStation
      ? `between ${fromStation} and ${toStation}`
      : 'line-wide';
  const expected = Number.isFinite(expectedTrains) ? Math.round(expectedTrains) : null;
  const expectedClause =
    expected && expected >= 1 ? `; ~${expected} trains normally running this time` : '';
  return {
    description: `🚆 ${lineTitle} · still no trains observed ${where} — ${elapsed} in${expectedClause}.`,
    evidence: {
      elapsedMin: Math.round(elapsedMin),
      from: fromStation ?? null,
      to: toStation ?? null,
      synthetic: synthetic === true,
      expectedTrains: expected,
    },
  };
}

// --- Orchestration: sweep open disruptions, post + record due updates ---

// `buildUpdate({ row, evidence, now })` returns { description, evidence } or a
// falsy value to skip. `row` is a findUnresolvedDisruptions row ({ id, ts, line,
// direction, from_station, to_station, evidence, postUri }); `evidence` is its
// parsed firing-time evidence. `getAgent()` returns the account that owns the
// incident's thread (the same one the bin posted from).
async function sweepProgressUpdates({
  kind,
  source,
  sinceMs = DEFAULT_REPLY_LOOKBACK_MS,
  now = Date.now(),
  getAgent,
  buildUpdate,
  dryRun = false,
  log = console.log,
}) {
  const open = history.findUnresolvedDisruptions({ kind, source, sinceMs }, now);
  for (const row of open) {
    const lastUpdateTs = history.getLatestIncidentUpdateTs(row.id);
    if (!dueForUpdate({ openedTs: row.ts, lastUpdateTs, now })) continue;

    let evidence = null;
    try {
      evidence = row.evidence ? JSON.parse(row.evidence) : null;
    } catch (_e) {
      evidence = null;
    }
    const update = buildUpdate({ row, evidence, now });
    if (!update?.description) continue;

    if (dryRun) {
      log(`--- DRY RUN progress update ${kind}/${row.line} ---\n${update.description}`);
      continue;
    }
    if (!row.postUri) continue;

    const agent = await getAgent();
    const replyRef = await resolveReplyRef(agent, row.postUri);
    if (!replyRef) {
      console.warn(
        `incident-update: could not resolve reply ref for ${row.postUri} (${kind}/${row.line}), skipping`,
      );
      continue;
    }
    const result = await postText(agent, update.description, replyRef);
    log(`Posted progress update ${kind}/${row.line}: ${result.url}`);
    history.recordIncidentUpdate({
      disruptionId: row.id,
      kind,
      line: row.line,
      direction: row.direction ?? null,
      source,
      ts: now,
      evidence: update.evidence ?? null,
      description: update.description,
      postUri: result.uri,
    });
  }
}

module.exports = {
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_MIN_AGE_MS,
  DEFAULT_REPLY_LOOKBACK_MS,
  dueForUpdate,
  formatElapsed,
  thinGapUpdate,
  busPulseUpdate,
  trainPulseUpdate,
  sweepProgressUpdates,
};
