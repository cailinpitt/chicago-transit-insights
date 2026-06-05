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

// Decide whether a published incident can be replayed, and pull the fields the
// track needs. Mirrors how the frontend (EventDetail → EventReplay) picks the
// line / segment / direction, so the archived track keys and geometry line up
// with what the page will ask for. Returns null when not replayable.
//
// Replayable = a train incident with a resolvable line and a two-station
// segment (from + to). Bus incidents have no schematic; segment-less incidents
// have nothing to highlight.
function pickReplayableIncident(incident) {
  if (!incident || incident.kind !== 'train') return null;
  const primary = incident.observations?.[0] ?? null;
  const cta = incident.cta ?? null;

  const lineLong = primary?.line ?? incident.routes?.[0] ?? null;
  const from = primary?.from_station ?? cta?.affected_from_station ?? null;
  const to = primary?.to_station ?? cta?.affected_to_station ?? null;
  if (!lineLong || !from || !to) return null;

  const lineShort = LONG_TO_SHORT[lineLong] ?? lineLong;
  const onset =
    primary?.onset_ts ?? primary?.ts ?? cta?.first_seen_ts ?? incident.first_seen_ts ?? null;
  const resolved = incident.resolved_ts ?? primary?.resolved_ts ?? cta?.resolved_ts ?? null;
  if (onset == null) return null;

  return {
    eventId: incident.id,
    lineLong,
    lineShort,
    from,
    to,
    stations: primary?.stations?.length ? primary.stations : [from, to],
    directionLabel: primary?.direction_label ?? cta?.affected_direction ?? null,
    onset,
    resolved,
    active: !!incident.active,
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

// Build the compact track payload from raw position rows. `rows` are
// observation rows for the line over the incident window:
//   { ts, vehicle_id, dir, lat, lon }
// Samples are stored relative to t0 (seconds) with 5-dp coords to keep the file
// tiny. Returns null when there's nothing positioned to show.
function buildTrack(meta, rows, now = Date.now()) {
  const positioned = (rows ?? []).filter(
    (r) => Number.isFinite(r.lat) && Number.isFinite(r.lon) && r.vehicle_id != null,
  );
  if (positioned.length === 0) return null;

  const t0 = Math.min(...positioned.map((r) => r.ts));
  const t1 = Math.max(...positioned.map((r) => r.ts));

  const byVehicle = new Map();
  for (const r of positioned) {
    let v = byVehicle.get(r.vehicle_id);
    if (!v) {
      v = {
        id: String(r.vehicle_id),
        dir: r.dir != null ? String(r.dir) : null,
        samples: new Map(),
      };
      byVehicle.set(r.vehicle_id, v);
    }
    // Last write wins on a duplicate relative-second key.
    v.samples.set(Math.round((r.ts - t0) / 1000), [
      Math.round((r.ts - t0) / 1000),
      Math.round(r.lat * 1e5) / 1e5,
      Math.round(r.lon * 1e5) / 1e5,
    ]);
  }

  const vehicles = [...byVehicle.values()]
    .map((v) => ({ id: v.id, dir: v.dir, s: [...v.samples.values()].sort((a, b) => a[0] - b[0]) }))
    .filter((v) => v.s.length > 0)
    .sort((a, b) => b.s.length - a.s.length);
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

module.exports = { LONG_TO_SHORT, pickReplayableIncident, resolveAffectedDir, buildTrack };
