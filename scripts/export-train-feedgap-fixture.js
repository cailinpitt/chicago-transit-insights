#!/usr/bin/env node
// Captures the GLOBAL train snapshot timestamps around a feed-outage incident
// so detectFeedGap can be regression-tested (test/train/pulseFeedGap.test.js).
// The feed-gap guard only needs distinct snapshot timestamps across all lines,
// so the fixture stores just those (tiny) plus the FP post times to replay the
// guard at, and a healthy control time.
//
// Usage: node scripts/export-train-feedgap-fixture.js [out-dir]   (run on server)
const Fs = require('node:fs');
const Path = require('node:path');
const Database = require('better-sqlite3');

const DB = process.env.HISTORY_DB || '/home/cailin/Development/cta-insights/state/history.sqlite';
const OUT = process.argv[2] || '/tmp/train-feedgap-fixtures';
Fs.mkdirSync(OUT, { recursive: true });
const db = new Database(DB, { readonly: true });

const FIXTURE = {
  name: 'train-feed-outage-2026-05-28',
  note:
    'Upstream feed/observe-trains outage 21:11→21:43 CDT (then stale-replaying on recovery). ' +
    'Posted a Purple full-line FP (456) plus Red/Blue (442/443, during the outage) and ' +
    'Red/Brown/Blue segment FPs in the recovery shadow (462/463/464/465). The feed-gap guard ' +
    'must fire at every fpPostTime and stay quiet at controlTs (healthy, pre-outage).',
  windowStart: 1780018200000, // 20:30 CDT
  windowEnd: 1780024500000, // 22:15 CDT
  controlTs: 1780020000000, // 21:00 CDT — pre-outage, feed healthy
  fpEventIds: [442, 443, 456, 462, 463, 464, 465],
};

const tsRows = db
  .prepare(
    `SELECT DISTINCT ts FROM observations
     WHERE kind='train' AND ts BETWEEN ? AND ?
     ORDER BY ts`,
  )
  .all(FIXTURE.windowStart, FIXTURE.windowEnd);
const snapshotTimestamps = tsRows.map((r) => r.ts);

const fpRows = db
  .prepare(
    `SELECT id, line, direction, ts FROM disruption_events WHERE id IN (${FIXTURE.fpEventIds.join(',')})`,
  )
  .all();
const fpPostTimes = {};
for (const r of fpRows) fpPostTimes[`${r.line}-${r.id}`] = r.ts;

// Largest gap in the captured snapshot stream (sanity / documentation).
let maxGapMs = 0;
let gapStartTs = null;
let gapEndTs = null;
for (let i = 1; i < snapshotTimestamps.length; i++) {
  const g = snapshotTimestamps[i] - snapshotTimestamps[i - 1];
  if (g > maxGapMs) {
    maxGapMs = g;
    gapStartTs = snapshotTimestamps[i - 1];
    gapEndTs = snapshotTimestamps[i];
  }
}

const out = {
  name: FIXTURE.name,
  note: FIXTURE.note,
  windowStart: FIXTURE.windowStart,
  windowEnd: FIXTURE.windowEnd,
  controlTs: FIXTURE.controlTs,
  gapStartTs,
  gapEndTs,
  gapMin: Math.round(maxGapMs / 60000),
  fpPostTimes,
  snapshotCount: snapshotTimestamps.length,
  snapshotTimestamps,
};
const outPath = Path.join(OUT, `${FIXTURE.name}.json`);
Fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(
  `wrote ${outPath} — ${snapshotTimestamps.length} snapshots, largest gap ${out.gapMin} min, ` +
    `fpPostTimes: ${Object.keys(fpPostTimes).length}`,
);
