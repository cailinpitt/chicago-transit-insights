#!/usr/bin/env node
// Captures real bus-pulse scenarios from the prod observations table into
// JSON fixtures for replay through detectBusBlackouts (test/bus/pulse.test.js).
//
// Unlike the train exporter, bus fixtures also carry the GTFS-derived
// headway / expected-active values from the original
// disruption_events.evidence so a replay matches production without needing
// the GTFS tables — the detector takes those as injected callbacks.
//
// Usage: node scripts/export-bus-fp-fixtures.js [out-dir]
//   (needs the prod sqlite DB, so run it on the server.)
const Fs = require('node:fs');
const Path = require('node:path');
const Database = require('better-sqlite3');

const DB = process.env.HISTORY_DB || '/home/cailin/Development/cta-insights/state/history.sqlite';
const OUT = process.argv[2] || '/tmp/bus-pulse-fixtures';
Fs.mkdirSync(OUT, { recursive: true });
const db = new Database(DB, { readonly: true });

// `coldRoutes` are the routes the detector actually flagged — the expected
// candidates when the feed-freshness guard is disabled. `healthyRoutes` are a
// representative set that still had in-window observations (so the
// pipeline-wide-quiet cross-route guard passes). headway / expectedActive come
// from the original disruption_events.evidence rows.
const FIXTURES = [
  {
    name: 'bus-feed-outage-2026-05-28-2143',
    note:
      'CTA Bus Tracker feed froze 21:06→21:44 CDT; every route went cold at once. ' +
      'Detector flagged 54/63/66/72/79 (all FPs). `now` is anchored to 21:43, the ' +
      'tick where all 5 were simultaneously strict-zero (54/66/72/79 went cold by ' +
      '21:33; 63, with a slightly longer headway, by 21:43). The global newest ' +
      'observation was ~37 min stale, yet the headway-scaled lookback still ' +
      'straddled pre-outage data, so pipeline-wide-quiet did not trip. The ' +
      'feed-freshness guard should skip with feed-stale.',
    now: 1780022582353,
    lookbackMs: 60 * 60 * 1000,
    coldRoutes: ['54', '63', '66', '72', '79'],
    healthyRoutes: ['53', '9', '49', '3', '82', '8', '22', '4'],
    headwayByRoute: {
      54: 7.941666666666666,
      63: 8.455,
      66: 7.1883333333333335,
      72: 5.818333333333333,
      79: 7.716666666666667,
    },
    expectedActiveByRoute: { 54: 7.6, 63: 10.8, 66: 14.3, 72: 12.5, 79: 17.9 },
    minuteOfHour: 43,
    expectedResult: 'feed-stale',
  },
];

const obsStmt = db.prepare(`
  SELECT ts, direction AS pid, vehicle_id AS vid
  FROM observations
  WHERE kind='bus' AND route=? AND ts BETWEEN ? AND ?
  ORDER BY ts
`);
const distinctTsStmt = db.prepare(`
  SELECT COUNT(DISTINCT ts) AS n FROM observations
  WHERE kind='bus' AND ts BETWEEN ? AND ?
`);

for (const f of FIXTURES) {
  const since = f.now - f.lookbackMs;
  const routes = [...f.coldRoutes, ...f.healthyRoutes];
  const observationsByRoute = {};
  let newestObsTs = 0;
  for (const r of routes) {
    // Thin to one observation per distinct snapshot timestamp. The detector
    // keys blackout decisions off distinct ts (cross-route guard) and whether
    // any vehicle is in the lookback (strict-zero) — collapsing duplicate
    // vehicles in the same snapshot preserves both while keeping the fixture
    // small.
    const seenTs = new Set();
    const rows = [];
    for (const o of obsStmt.all(r, since, f.now)) {
      if (seenTs.has(o.ts)) continue;
      seenTs.add(o.ts);
      rows.push({ ts: o.ts, pid: o.pid, vid: o.vid });
      if (o.ts > newestObsTs) newestObsTs = o.ts;
    }
    observationsByRoute[r] = rows;
  }
  // Match production: globalDistinctTs counts distinct snapshot timestamps
  // across the WHOLE bus feed, not just the captured routes.
  const globalDistinctTs = distinctTsStmt.get(since, f.now).n;
  const out = {
    name: f.name,
    note: f.note,
    now: f.now,
    lookbackMs: f.lookbackMs,
    minuteOfHour: f.minuteOfHour,
    globalDistinctTs,
    newestObsTs,
    staleMs: f.now - newestObsTs,
    coldRoutes: f.coldRoutes,
    routes,
    headwayByRoute: f.headwayByRoute,
    expectedActiveByRoute: f.expectedActiveByRoute,
    expectedResult: f.expectedResult,
    observationsByRoute,
  };
  const outPath = Path.join(OUT, `${f.name}.json`);
  Fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(
    `wrote ${outPath} — ${routes.length} routes, newest ${newestObsTs} ` +
      `(${Math.round((f.now - newestObsTs) / 60000)} min stale), globalDistinctTs ${globalDistinctTs}`,
  );
}
