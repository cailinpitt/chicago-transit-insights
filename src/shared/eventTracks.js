// Pure helpers for the event-replay archiver (bin/export-event-tracks.js).
//
// A "track" is the compact, per-incident vehicle-position file the frontend's
// EventReplay animates. We extract it from `observations` (which roll off after
// 7 days) and park it on R2 keyed by the incident's permalink id, so an event
// page can replay the disruption long after the raw positions are gone.
//
// Everything here is a pure function over plain data so it can be unit-tested
// without a DB, the network, or importing the bin (whose import would run live).

// Feed line keys are full names ('orange'); `observations.route` /
// `disruption_events.line` use short GTFS codes ('org'). Mirror of
// directionLabel.js's LONG_TO_SHORT.
const LONG_TO_SHORT = {
  red: 'red',
  blue: 'blue',
  green: 'g',
  brown: 'brn',
  orange: 'org',
  purple: 'p',
  pink: 'pink',
  yellow: 'y',
};

const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

function incidentMode(incident) {
  return incident?.mode ?? (incident?.kind === 'metra' ? 'commuter_rail' : incident?.kind);
}

function incidentLifecycle(incident) {
  return (
    incident?.lifecycle ?? {
      first_seen_ts: incident?.first_seen_ts ?? null,
      resolved_ts: incident?.resolved_ts ?? null,
      active: incident?.active ?? false,
    }
  );
}

function officialAlert(incident) {
  return incident?.official_alert ?? incident?.cta ?? null;
}

function detections(incident) {
  return incident?.detections ?? incident?.observations ?? [];
}

function officialScope(alert) {
  return (
    alert?.scope ?? {
      from_station: alert?.affected_from_station ?? null,
      to_station: alert?.affected_to_station ?? null,
      direction: alert?.affected_direction ?? null,
      stations: alert?.affected_stations ?? [],
    }
  );
}

function officialLifecycle(alert) {
  return (
    alert?.lifecycle ?? {
      first_seen_ts: alert?.first_seen_ts ?? null,
      resolved_ts: alert?.resolved_ts ?? null,
      active: alert?.active ?? false,
    }
  );
}

function detectionScope(detection) {
  return (
    detection?.scope ?? {
      route: detection?.line ?? null,
      from_station: detection?.from_station ?? null,
      to_station: detection?.to_station ?? null,
      direction: detection?.direction ?? null,
      direction_label: detection?.direction_label ?? null,
      stations: detection?.stations ?? [],
    }
  );
}

function detectionLifecycle(detection) {
  return (
    detection?.lifecycle ?? {
      first_seen_ts: detection?.ts ?? null,
      onset_ts: detection?.onset_ts ?? null,
      resolved_ts: detection?.resolved_ts ?? null,
      active: detection?.active ?? false,
    }
  );
}

// Decide whether a published incident can be replayed, and pull the fields the
// track needs. Mirrors how the frontend (EventDetail → EventReplay) picks the
// line / segment / direction, so the archived track keys and geometry line up
// with what the page will ask for. Returns null when not replayable.
//
// Replayable = a train incident with a resolvable line and a two-station
// segment (from + to). Bus incidents have no schematic; segment-less incidents
// have nothing to highlight.
function pickReplayableIncident(incident) {
  if (!incident || incidentMode(incident) !== 'train') return null;
  const primary = detections(incident)[0] ?? null;
  const alert = officialAlert(incident);
  const primaryScope = detectionScope(primary);
  const primaryLifecycle = detectionLifecycle(primary);
  const alertScope = officialScope(alert);
  const alertLifecycle = officialLifecycle(alert);
  const lifecycle = incidentLifecycle(incident);

  const lineLong = primaryScope.route ?? incident.routes?.[0] ?? null;
  const from = primaryScope.from_station ?? alertScope.from_station ?? null;
  const to = primaryScope.to_station ?? alertScope.to_station ?? null;
  if (!lineLong || !from || !to) return null;

  const lineShort = LONG_TO_SHORT[lineLong] ?? lineLong;
  const onset =
    primaryLifecycle.onset_ts ??
    primaryLifecycle.first_seen_ts ??
    alertLifecycle.first_seen_ts ??
    lifecycle.first_seen_ts ??
    null;
  const resolved =
    lifecycle.resolved_ts ?? primaryLifecycle.resolved_ts ?? alertLifecycle.resolved_ts ?? null;
  if (onset == null) return null;

  return {
    eventId: incident.id,
    lineLong,
    lineShort,
    from,
    to,
    stations: primaryScope.stations?.length ? primaryScope.stations : [from, to],
    directionLabel: primaryScope.direction_label ?? alertScope.direction ?? null,
    onset,
    resolved,
    active: !!lifecycle.active,
  };
}

// Resolve the affected direction's `dir` code (CTA trDr) from the human
// direction label, by matching its named terminus to the destination text the
// trains in that direction carry. Destination text is authoritative (a Loop-
// bound train is destined "Loop"); position heuristics are too noisy overnight.
//
// `destByDir`: { [dir]: destinationString } — one representative destination per
// direction seen on the line in the window. Returns null when nothing resolves
// (single-branch lines, 'all', unparseable label) → frontend falls back to
// undirected occupancy.
function resolveAffectedDir(directionLabel, destByDir) {
  const m = directionLabel?.match(/toward\s+(.+)$/i);
  if (!m || !destByDir) return null;
  const term = m[1].trim();
  const wantLoop = /loop|downtown/i.test(term);
  const termSlug = slug(term);

  for (const [dir, dest] of Object.entries(destByDir)) {
    const destSlug = slug(dest);
    if (wantLoop) {
      if (destSlug.includes('loop')) return dir;
      continue;
    }
    if (
      destSlug &&
      (destSlug === termSlug || destSlug.includes(termSlug) || termSlug.includes(destSlug))
    ) {
      return dir;
    }
  }
  return null;
}

// A new direction must persist for at least this many consecutive pings before
// we treat it as a real turnaround and split the track. A 1-ping opposite-dir
// blip (CTA trDr noise) is absorbed into the current run instead.
const MIN_DIR_RUN = 2;

// Split a vehicle's ts-ordered rows into runs of a single travel direction. A
// train that reverses at a terminal under the same run number (rn) otherwise
// merges into one zig-zag track, which the frontend's monotonic de-jitter then
// mangles (it drops every "backward" sample, deleting a whole leg). Splitting
// at the reversal makes each leg its own track that fades out at the terminal
// and back in on the return — which is what actually happened.
//
// `null` directions (legacy rows / unknown) never trigger a split; they inherit
// the current run. Returns [{ dir, rows }] in time order.
function segmentByDirection(rows) {
  const runs = [];
  for (const r of rows) {
    const dir = r.dir != null ? String(r.dir) : null;
    const last = runs[runs.length - 1];
    if (!last || (dir != null && last.dir != null && last.dir !== dir)) {
      runs.push({ dir: dir ?? last?.dir ?? null, rows: [r] });
    } else {
      if (last.dir == null && dir != null) last.dir = dir;
      last.rows.push(r);
    }
  }
  if (runs.length <= 1) return runs;
  // Absorb sub-MIN_DIR_RUN blips into the preceding run, then coalesce adjacent
  // runs that end up sharing a direction (a blip that split two same-dir runs).
  const merged = [runs[0]];
  for (let i = 1; i < runs.length; i++) {
    const prev = merged[merged.length - 1];
    if (runs[i].rows.length < MIN_DIR_RUN) prev.rows.push(...runs[i].rows);
    else merged.push(runs[i]);
  }
  const coalesced = [merged[0]];
  for (let i = 1; i < merged.length; i++) {
    const prev = coalesced[coalesced.length - 1];
    if (merged[i].dir === prev.dir) prev.rows.push(...merged[i].rows);
    else coalesced.push(merged[i]);
  }
  return coalesced;
}

// Build the compact track payload from raw position rows. `rows` are
// observation rows for the line over the incident window:
//   { ts, vehicle_id, dir, lat, lon }
// Samples are stored relative to t0 (seconds) with 5-dp coords to keep the file
// tiny. Returns null when there's nothing positioned to show.
function buildTrack(meta, rows, now = Date.now()) {
  const positioned = (rows ?? [])
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon) && r.vehicle_id != null)
    // Sort by ts so segmentation + relative-second keys are correct regardless
    // of the query's row order (defensive — the DB read already ORDER BYs ts).
    .sort((a, b) => a.ts - b.ts);
  if (positioned.length === 0) return null;

  const t0 = positioned[0].ts;
  const t1 = positioned[positioned.length - 1].ts;

  // Group rows per vehicle (ts order preserved), then split each into single-
  // direction legs. A reversing train becomes `<rn>` and `<rn>~1`, `<rn>~2`…
  const rowsByVehicle = new Map();
  for (const r of positioned) {
    const key = String(r.vehicle_id);
    if (!rowsByVehicle.has(key)) rowsByVehicle.set(key, []);
    rowsByVehicle.get(key).push(r);
  }

  const vehicles = [];
  for (const [vid, vrows] of rowsByVehicle) {
    const segs = segmentByDirection(vrows);
    segs.forEach((seg, idx) => {
      const samples = new Map(); // relSec -> [relSec, lat, lon], last write wins
      for (const r of seg.rows) {
        const relSec = Math.round((r.ts - t0) / 1000);
        samples.set(relSec, [relSec, Math.round(r.lat * 1e5) / 1e5, Math.round(r.lon * 1e5) / 1e5]);
      }
      const s = [...samples.values()].sort((a, b) => a[0] - b[0]);
      if (s.length === 0) return;
      vehicles.push({ id: idx === 0 ? vid : `${vid}~${idx}`, dir: seg.dir, s });
    });
  }
  vehicles.sort((a, b) => b.s.length - a.s.length);
  if (vehicles.length === 0) return null;

  return {
    eventId: meta.eventId,
    line: meta.lineLong,
    from: meta.from,
    to: meta.to,
    stations: meta.stations,
    onset: meta.onset,
    resolved: meta.resolved ?? null,
    affectedDir: meta.affectedDir ?? null,
    generatedAt: now,
    t0,
    t1,
    durSec: Math.round((t1 - t0) / 1000),
    vehicles,
  };
}

module.exports = {
  LONG_TO_SHORT,
  pickReplayableIncident,
  resolveAffectedDir,
  buildTrack,
  segmentByDirection,
};
