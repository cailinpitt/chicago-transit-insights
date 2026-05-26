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
//   - Two top-level totals per day:
//       train_count / bus_count          — raw counts, no merge. A CTA alert
//         plus a matching bot observation counts as 2. Useful for "amount of
//         signal activity that day."
//       train_merged_count / bus_merged_count — distinct-incident counts.
//         A CTA alert and a matching bot observation collapse into 1.
//         Mirrors the Timeline view on the web side so the calendar tile
//         number matches what users see when they click through.
//     Merge logic is inlined below; intentionally duplicated from
//     cta-alert-history/src/lib/incidents.js — cross-repo sharing was
//     considered and punted on (one source of truth lives there for now;
//     keep the two implementations in sync if either changes).
//   - Multi-route alerts (e.g. Red+Purple shared trackage) count once in
//     train_count and once per route in by_line. Means sum(by_line) can
//     exceed train_count when shared-trackage alerts fire. by_line and
//     by_route remain raw per-route counts — no _merged variant.

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

// Train line short-code → full-name aliases. Mirrors the SPA's
// normalizeTrainLine so alert.routes and observation.line use the same keys
// when the merge tries to match them.
const LINE_ALIAS = { brn: 'brown', g: 'green', org: 'orange', p: 'purple', y: 'yellow' };
function normalizeTrainLine(key) {
  if (key == null) return key;
  return LINE_ALIAS[key] ?? key;
}

// Pair each alert with overlapping bot observations on the same line within
// a 2-hour window. Returns merged records plus the leftover standalones.
// Direct port of mergeMatchingIncidents from cta-alert-history/src/lib/
// incidents.js — keep the two in sync.
function mergeMatchingIncidents(alerts, observations) {
  const BUFFER_MS = 2 * 60 * 60 * 1000;
  const GRACE_MS = 10 * 60 * 1000;
  const usedObsIds = new Set();
  const usedAlertIds = new Set();
  const merged = [];

  for (const alert of alerts) {
    const matches = [];
    for (const obs of observations) {
      if (usedObsIds.has(obs.id)) continue;
      if (alert.kind !== obs.kind) continue;
      if (!alert.routes.includes(obs.line)) continue;
      if (Math.abs(obs.ts - alert.first_seen_ts) > BUFFER_MS) continue;
      const obsEnd = obs.resolved_ts ?? obs.ts;
      const alertEnd = alert.resolved_ts ?? Number.POSITIVE_INFINITY;
      if (obsEnd + GRACE_MS < alert.first_seen_ts) continue;
      if (alertEnd + GRACE_MS < obs.ts) continue;
      matches.push(obs);
    }
    if (matches.length === 0) continue;
    merged.push({ alert_id: alert.alert_id, kind: alert.kind, ts: alert.first_seen_ts });
    for (const o of matches) usedObsIds.add(o.id);
    usedAlertIds.add(alert.alert_id);
  }

  return {
    merged,
    standaloneAlerts: alerts.filter((a) => !usedAlertIds.has(a.alert_id)),
    standaloneObs: observations.filter((o) => !usedObsIds.has(o.id)),
  };
}

function main() {
  const db = new Database(DB_PATH, { readonly: true });

  const alertRows = db
    .prepare('SELECT alert_id, kind, routes, first_seen_ts, resolved_ts FROM alert_posts')
    .all();

  // Same resolved_ts subquery shape as export-web.js — find the earliest
  // matching observed-clear on the same line/direction/segment after this
  // detection. Needed so the merge window check (obs interval overlaps
  // alert interval) uses the full obs lifespan, not just its start.
  const pulseObsRows = db
    .prepare(
      `SELECT
        d.id, d.kind, d.line, d.ts,
        (
          SELECT MIN(c.ts)
          FROM disruption_events c
          WHERE c.kind = d.kind AND c.source = 'observed-clear'
            AND c.ts >= d.ts
            AND IFNULL(c.line, '')          = IFNULL(d.line, '')
            AND IFNULL(c.direction, '')     = IFNULL(d.direction, '')
            AND IFNULL(c.from_station, '')  = IFNULL(d.from_station, '')
            AND IFNULL(c.to_station, '')    = IFNULL(d.to_station, '')
        ) AS resolved_ts
       FROM disruption_events d
       WHERE d.source IN ('observed', 'observed-held', 'observed-thin') AND d.posted = 1`,
    )
    .all();

  const roundupRows = db
    .prepare('SELECT id, kind, line, ts, resolved_ts FROM roundup_anchors')
    .all();

  const dataStart = db
    .prepare(
      `SELECT MIN(ts) as min_ts FROM (
         SELECT MIN(first_seen_ts) as ts FROM alert_posts
         UNION ALL
         SELECT MIN(ts) as ts FROM disruption_events WHERE source IN ('observed', 'observed-held', 'observed-thin') AND posted = 1
         UNION ALL
         SELECT MIN(ts) as ts FROM roundup_anchors
       )`,
    )
    .get();

  db.close();

  // Normalize to the merge function's expected shape. Train line keys get
  // collapsed to full names so 'g' / 'green' compare equal across the alert
  // and observation sides.
  const normAlerts = alertRows
    .filter((a) => a.first_seen_ts != null)
    .map((a) => {
      const routes = (a.routes || '').split(',').filter(Boolean);
      const normRoutes = a.kind === 'train' ? routes.map(normalizeTrainLine) : routes;
      return {
        alert_id: a.alert_id,
        kind: a.kind,
        routes: normRoutes,
        first_seen_ts: a.first_seen_ts,
        resolved_ts: a.resolved_ts ?? null,
      };
    });

  // Roundup IDs and disruption_event IDs come from different tables and can
  // collide; namespace them so the merge's usedObsIds set tracks each
  // distinct record.
  const normObs = [
    ...pulseObsRows
      .filter((o) => o.ts != null)
      .map((o) => ({
        id: `p${o.id}`,
        kind: o.kind,
        line: o.kind === 'train' ? normalizeTrainLine(o.line) : o.line,
        ts: o.ts,
        resolved_ts: o.resolved_ts ?? null,
      })),
    ...roundupRows
      .filter((r) => r.ts != null)
      .map((r) => ({
        id: `r${r.id}`,
        kind: r.kind,
        line: r.kind === 'train' ? normalizeTrainLine(r.line) : r.line,
        ts: r.ts,
        resolved_ts: r.resolved_ts ?? null,
      })),
  ];

  const { merged, standaloneAlerts, standaloneObs } = mergeMatchingIncidents(normAlerts, normObs);

  // Bucket by Chicago calendar day. Each entry: train_count + bus_count are
  // raw signal totals; train_merged_count + bus_merged_count collapse a CTA
  // alert + matching bot observation into one. by_line/by_route remain
  // per-route counts that may sum higher when an alert covers multiple routes.
  const byDay = new Map();

  function ensureDay(date) {
    let rec = byDay.get(date);
    if (!rec) {
      rec = {
        train_count: 0,
        bus_count: 0,
        train_merged_count: 0,
        bus_merged_count: 0,
        by_line: {},
        by_route: {},
      };
      byDay.set(date, rec);
    }
    return rec;
  }

  function bumpRoute(rec, kind, lineOrRoute) {
    if (!lineOrRoute) return;
    const target = kind === 'train' ? rec.by_line : rec.by_route;
    target[lineOrRoute] = (target[lineOrRoute] || 0) + 1;
  }

  // Raw counts: every alert, observation, and roundup gets its own tally.
  for (const a of alertRows) {
    if (a.first_seen_ts == null) continue;
    const rec = ensureDay(chicagoDate(a.first_seen_ts));
    if (a.kind === 'train') rec.train_count += 1;
    else if (a.kind === 'bus') rec.bus_count += 1;
    const routes = (a.routes || '').split(',').filter(Boolean);
    for (const r of routes) bumpRoute(rec, a.kind, r);
  }
  for (const o of pulseObsRows) {
    if (o.ts == null) continue;
    const rec = ensureDay(chicagoDate(o.ts));
    if (o.kind === 'train') rec.train_count += 1;
    else if (o.kind === 'bus') rec.bus_count += 1;
    bumpRoute(rec, o.kind, o.line);
  }
  for (const r of roundupRows) {
    if (r.ts == null) continue;
    const rec = ensureDay(chicagoDate(r.ts));
    if (r.kind === 'train') rec.train_count += 1;
    else if (r.kind === 'bus') rec.bus_count += 1;
    bumpRoute(rec, r.kind, r.line);
  }

  // Merged counts: merged records count once (bucketed by the alert's
  // first_seen_ts, matching the SPA's merge anchor), standalone alerts and
  // standalone observations each count once on their own start day.
  for (const m of merged) {
    const rec = ensureDay(chicagoDate(m.ts));
    if (m.kind === 'train') rec.train_merged_count += 1;
    else if (m.kind === 'bus') rec.bus_merged_count += 1;
  }
  for (const a of standaloneAlerts) {
    const rec = ensureDay(chicagoDate(a.first_seen_ts));
    if (a.kind === 'train') rec.train_merged_count += 1;
    else if (a.kind === 'bus') rec.bus_merged_count += 1;
  }
  for (const o of standaloneObs) {
    const rec = ensureDay(chicagoDate(o.ts));
    if (o.kind === 'train') rec.train_merged_count += 1;
    else if (o.kind === 'bus') rec.bus_merged_count += 1;
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
