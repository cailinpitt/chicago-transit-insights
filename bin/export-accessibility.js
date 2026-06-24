#!/usr/bin/env node
require('../src/shared/env');

const Fs = require('node:fs');
const Path = require('node:path');
const { ACCESSIBILITY_ROLLOFF_MS, getAccessibilityOutages } = require('../src/shared/history');

const WINDOW_DAYS = Math.round(ACCESSIBILITY_ROLLOFF_MS / (24 * 60 * 60 * 1000));

function outageBlock(row, now) {
  const active = row.active && row.restoredTs == null;
  const endTs = active ? now : row.restoredTs;
  return {
    id: row.sourceId,
    agency: row.agency,
    station: {
      slug: row.stationSlug ?? null,
      name: row.stationName ?? null,
      lines: row.lines || [],
    },
    unit_type: row.unitType,
    unit_label: row.unitLabel ?? null,
    headline: row.headline ?? null,
    description: row.description ?? null,
    lifecycle: {
      first_seen_ts: row.firstSeenTs,
      restored_ts: row.restoredTs ?? null,
      active,
      duration_ms:
        active || endTs == null || row.firstSeenTs == null
          ? null
          : Math.max(0, endTs - row.firstSeenTs),
    },
    source_url: row.sourceUrl ?? null,
  };
}

function buildAccessibilityPayload({ now = Date.now() } = {}) {
  const dataStartTs = now - ACCESSIBILITY_ROLLOFF_MS;
  const outages = getAccessibilityOutages(dataStartTs).map((row) => outageBlock(row, now));
  return {
    schema_version: 1,
    generated_at: now,
    data_start_ts: dataStartTs,
    window_days: WINDOW_DAYS,
    outages,
  };
}

function main(argv = process.argv.slice(2)) {
  const outPath = argv[0] || Path.join(__dirname, '..', 'tmp', 'web-data', 'accessibility.json');
  const payload = buildAccessibilityPayload();
  Fs.mkdirSync(Path.dirname(outPath), { recursive: true });
  Fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`wrote ${outPath} (${payload.outages.length} accessibility outages)`);
}

if (require.main === module) {
  main();
}

module.exports = { buildAccessibilityPayload, outageBlock };
