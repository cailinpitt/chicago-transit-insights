#!/usr/bin/env node
// Exports per-day incident counts for the calendar visualization on the
// public web dashboard. Smaller than alerts.json (no per-incident detail)
// and grows as O(days) rather than O(incidents). Reads the DB in readonly
// mode — safe to run alongside cron jobs.
//
// Usage:
//   node bin/export-daily.js [output-path]
//
// If output-path is omitted, JSON is written to stdout.
//
// Counting choices (intentional, may differ slightly from Timeline):
//   - Bucket by START time in Chicago calendar days. A multi-day disruption
//     counts once on its start day, not every day it touched. Matches the
//     hour-of-week heatmap semantics on the web side.
//   - Raw counts, no alert↔observation merge. A CTA alert + matching bot
//     observation that describe the same incident will count as 2 here
//     where Timeline (which merges) would show 1. Accurate for "amount of
//     activity that day" and avoids re-implementing merge logic on this
//     side of the pipeline.
//   - Multi-route alerts (e.g. Red+Purple shared trackage) count once in
//     train_count and once per route in by_line. Means sum(by_line) can
//     exceed train_count when shared-trackage alerts fire.

require('../src/shared/env');

const Path = require('node:path');
const Fs = require('node:fs');
const Database = require('better-sqlite3');

const DB_PATH =
  process.env.HISTORY_DB_PATH || Path.join(__dirname, '..', 'state', 'history.sqlite');

const CHICAGO_TZ = 'America/Chicago';
// en-CA's default format for these options is YYYY-MM-DD (ISO 8601 order),
// which is what we want for the date keys. The locale pick is purely about
// component ordering — output is language-neutral digits, so this isn't a
// statement about the audience. en-US would give MM/DD/YYYY here.
const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: CHICAGO_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function chicagoDate(epochMs) {
  return dayFmt.format(new Date(epochMs));
}

function main() {
  const db = new Database(DB_PATH, { readonly: true });

  const alerts = db.prepare('SELECT kind, routes, first_seen_ts FROM alert_posts').all();
  const pulseObs = db
    .prepare(
      `SELECT kind, line, ts FROM disruption_events
       WHERE source IN ('observed', 'observed-held') AND posted = 1`,
    )
    .all();
  const roundups = db.prepare('SELECT kind, line, ts FROM roundup_anchors').all();

  const dataStart = db
    .prepare(
      `SELECT MIN(ts) as min_ts FROM (
         SELECT MIN(first_seen_ts) as ts FROM alert_posts
         UNION ALL
         SELECT MIN(ts) as ts FROM disruption_events WHERE source IN ('observed', 'observed-held') AND posted = 1
         UNION ALL
         SELECT MIN(ts) as ts FROM roundup_anchors
       )`,
    )
    .get();

  db.close();

  // Bucket by Chicago calendar day. Each entry: train_count + bus_count are
  // distinct-incident totals; by_line/by_route are per-route counts that may
  // sum higher when an alert covers multiple routes.
  const byDay = new Map();

  function ensureDay(date) {
    let rec = byDay.get(date);
    if (!rec) {
      rec = { train_count: 0, bus_count: 0, by_line: {}, by_route: {} };
      byDay.set(date, rec);
    }
    return rec;
  }

  function bumpRoute(rec, kind, lineOrRoute) {
    if (!lineOrRoute) return;
    const target = kind === 'train' ? rec.by_line : rec.by_route;
    target[lineOrRoute] = (target[lineOrRoute] || 0) + 1;
  }

  for (const a of alerts) {
    if (a.first_seen_ts == null) continue;
    const rec = ensureDay(chicagoDate(a.first_seen_ts));
    if (a.kind === 'train') rec.train_count += 1;
    else if (a.kind === 'bus') rec.bus_count += 1;
    const routes = (a.routes || '').split(',').filter(Boolean);
    for (const r of routes) bumpRoute(rec, a.kind, r);
  }

  for (const o of pulseObs) {
    if (o.ts == null) continue;
    const rec = ensureDay(chicagoDate(o.ts));
    if (o.kind === 'train') rec.train_count += 1;
    else if (o.kind === 'bus') rec.bus_count += 1;
    bumpRoute(rec, o.kind, o.line);
  }

  for (const r of roundups) {
    if (r.ts == null) continue;
    const rec = ensureDay(chicagoDate(r.ts));
    if (r.kind === 'train') rec.train_count += 1;
    else if (r.kind === 'bus') rec.bus_count += 1;
    bumpRoute(rec, r.kind, r.line);
  }

  const days = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, rec]) => ({ date, ...rec }));

  const out = {
    generated_at: Date.now(),
    data_start_ts: dataStart?.min_ts ?? null,
    days,
  };

  const outputPath = process.argv[2];

  if (outputPath) {
    // Skip the write (and therefore any commit) when nothing meaningful has
    // changed. generated_at advances every run so we compare only the data.
    const nextSig = JSON.stringify({ data_start_ts: out.data_start_ts, days: out.days });
    let prevSig = null;
    if (Fs.existsSync(outputPath)) {
      try {
        const existing = JSON.parse(Fs.readFileSync(outputPath, 'utf8'));
        prevSig = JSON.stringify({
          data_start_ts: existing.data_start_ts,
          days: existing.days,
        });
      } catch (_) {}
    }
    if (nextSig === prevSig) {
      console.error('export-daily: no data changes, skipping write');
      return;
    }
    Fs.writeFileSync(outputPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
    console.error(`export-daily: wrote ${days.length} days to ${outputPath}`);
  } else {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  }
}

main();
