#!/usr/bin/env node
// Generate alerts.csv from the public alerts.json payload.
//
// This mirrors cta-alert-history's browser/download CSV schema, but lives in
// cta-insights so the R2 data publisher can ship JSON and CSV together.

const Fs = require('node:fs');

const CSV_COLUMNS = [
  'record_type',
  'incident_id',
  'agency',
  'mode',
  'routes',
  'source',
  'status_type',
  'headline',
  'description',
  'from_station',
  'to_station',
  'stations',
  'direction',
  'direction_label',
  'first_seen_ts',
  'onset_ts',
  'resolved_ts',
  'duration_minutes',
  'active',
  'post_url',
  'resolved_post_url',
];

function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

function isoOrEmpty(ms) {
  if (ms == null) return '';
  return new Date(ms).toISOString();
}

function lifecycleDurationMinutes(lifecycle) {
  if (!lifecycle) return '';
  if (lifecycle.duration_ms != null) return Math.round(lifecycle.duration_ms / 60_000);
  if (lifecycle.resolved_ts != null && lifecycle.first_seen_ts != null) {
    return Math.round(
      (lifecycle.resolved_ts - (lifecycle.onset_ts ?? lifecycle.first_seen_ts)) / 60_000,
    );
  }
  return '';
}

function officialRow(inc) {
  const a = inc.official_alert;
  const scope = a?.scope ?? {};
  const lifecycle = a?.lifecycle ?? {};
  return {
    record_type: 'official_alert',
    incident_id: inc.id,
    agency: inc.agency,
    mode: inc.mode,
    routes: (inc.routes ?? []).join(';'),
    source: 'official',
    status_type: inc.status?.type ?? '',
    headline: a?.headline ?? '',
    description: a?.description ?? '',
    from_station: scope.from_station ?? '',
    to_station: scope.to_station ?? '',
    stations: (scope.stations ?? scope.mentioned_stations ?? []).join(';'),
    direction: scope.direction ?? '',
    direction_label: '',
    first_seen_ts: isoOrEmpty(lifecycle.first_seen_ts),
    onset_ts: '',
    resolved_ts: isoOrEmpty(lifecycle.resolved_ts),
    duration_minutes: lifecycleDurationMinutes(lifecycle),
    active: lifecycle.active ? 'true' : 'false',
    post_url: a?.post_url ?? '',
    resolved_post_url: a?.resolved_reply_url ?? '',
  };
}

function detectionRow(inc, detection) {
  const scope = detection.scope ?? {};
  const lifecycle = detection.lifecycle ?? {};
  return {
    record_type: 'detection',
    incident_id: inc.id,
    agency: inc.agency,
    mode: inc.mode,
    routes: (inc.routes ?? []).join(';'),
    source: detection.source ?? '',
    status_type: inc.status?.type ?? '',
    headline: '',
    description: detection.description ?? '',
    from_station: scope.from_station ?? '',
    to_station: scope.to_station ?? '',
    stations: (scope.stations ?? []).join(';'),
    direction: scope.direction ?? '',
    direction_label: scope.direction_label ?? '',
    first_seen_ts: isoOrEmpty(lifecycle.first_seen_ts),
    onset_ts: isoOrEmpty(lifecycle.onset_ts),
    resolved_ts: isoOrEmpty(lifecycle.resolved_ts),
    duration_minutes: lifecycleDurationMinutes(lifecycle),
    active: lifecycle.active ? 'true' : 'false',
    post_url: detection.post_url ?? '',
    resolved_post_url: detection.resolved_post_url ?? '',
  };
}

function rowToCsv(row) {
  return CSV_COLUMNS.map((c) => csvEscape(row[c])).join(',');
}

function buildCsv(incidents) {
  const rows = [];
  for (const inc of incidents ?? []) {
    if (inc.official_alert) rows.push(officialRow(inc));
    for (const detection of inc.detections ?? []) rows.push(detectionRow(inc, detection));
  }
  rows.sort((a, b) =>
    b.first_seen_ts < a.first_seen_ts ? -1 : b.first_seen_ts > a.first_seen_ts ? 1 : 0,
  );
  return `${[CSV_COLUMNS.join(','), ...rows.map(rowToCsv)].join('\n')}\n`;
}

function buildCsvFromPayload(payload) {
  return buildCsv(payload?.incidents || []);
}

function main() {
  const input = process.argv[2];
  const output = process.argv[3];
  if (!input || !output) {
    console.error('usage: export-csv.js <alerts.json> <alerts.csv>');
    process.exit(2);
  }
  const payload = JSON.parse(Fs.readFileSync(input, 'utf8'));
  const csv = buildCsvFromPayload(payload);
  Fs.writeFileSync(output, csv, 'utf8');
  const rowCount = Math.max(0, csv.split('\n').length - 2);
  console.error(`export-csv: wrote ${rowCount} rows to ${output}`);
}

if (require.main === module) main();

module.exports = { buildCsv, buildCsvFromPayload, CSV_COLUMNS };
