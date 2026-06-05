#!/usr/bin/env node
// Archive per-incident vehicle-position "tracks" to R2 so event pages can replay
// a disruption after the raw positions roll off (observations keep only 7 days).
//
// Driven off the *published* alerts.json (the authoritative event identity +
// segment/direction fields), hitting the DB only for raw positions — so a
// track's key always matches the page that fetches it, with no need to
// re-derive incident ids here. See docs/REPLAY.md.
//
// Cron-safe one-shot: read alerts.json → for each replayable train incident in
// the retention window, extract its positions → gzip → rclone to
// r2web:cta-alert-history-data/tracks/<id>.json. A manifest skips incidents
// already archived after they resolved; active ones re-upload each run until
// they do. --dry-run writes the JSON to tmp/ and uploads nothing.
require('../src/shared/env');

const Fs = require('node:fs');
const Path = require('node:path');
const Zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const argv = require('minimist')(process.argv.slice(2));

const { runBin } = require('../src/shared/runBin');
const {
  pickReplayableIncident,
  resolveAffectedDir,
  buildTrack,
} = require('../src/shared/eventTracks');

const REPO = Path.join(__dirname, '..');
const DB_PATH = process.env.HISTORY_DB_PATH || Path.join(REPO, 'state', 'history.sqlite');
const MANIFEST_PATH = Path.join(REPO, 'state', 'track-manifest.json');
const WORK_DIR = Path.join(REPO, 'tmp', 'event-tracks');
const REMOTE = process.env.RCLONE_REMOTE || 'r2web:cta-alert-history-data';
const ALERTS_URL = process.env.DATA_ORIGIN_URL || 'https://data.chicagotransitalerts.app';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAD_MS = 5 * 60 * 1000; // pad the window so a train is on screen before/after the cold
// Observations roll off at 7 days; stay inside that so we never archive a
// window whose positions are already (partly) gone.
const RETENTION_MS = (argv['window-days'] ? Number(argv['window-days']) : 6.5) * DAY_MS;

async function loadAlerts() {
  if (argv.alerts) return JSON.parse(Fs.readFileSync(argv.alerts, 'utf8'));
  // Prefer the copy push-web-data.sh just wrote locally; fall back to the live
  // origin so the job works even if run out of band.
  const local = Path.join(REPO, 'tmp', 'web-data', 'alerts.json');
  if (Fs.existsSync(local)) return JSON.parse(Fs.readFileSync(local, 'utf8'));
  const res = await fetch(`${ALERTS_URL}/alerts.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`fetch alerts.json: ${res.status}`);
  return res.json();
}

function loadManifest() {
  try {
    return JSON.parse(Fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

// Representative destination per direction code on the line in the window —
// authoritative for resolving the affected direction (a Loop-bound train is
// destined "Loop"). Ordered by frequency so the dominant destination wins.
function destByDir(db, lineShort, qstart, qend) {
  const rows = db
    .prepare(
      `SELECT direction AS dir, destination, COUNT(*) AS c
         FROM observations
        WHERE kind = 'train' AND route = ? AND ts BETWEEN ? AND ?
          AND destination IS NOT NULL AND direction IS NOT NULL
        GROUP BY dir, destination ORDER BY c DESC`,
    )
    .all(lineShort, qstart, qend);
  const out = {};
  for (const r of rows) if (!(r.dir in out)) out[r.dir] = r.destination;
  return out;
}

function uploadTrack(eventId, track, finalized) {
  Fs.mkdirSync(WORK_DIR, { recursive: true });
  const gz = Zlib.gzipSync(Buffer.from(`${JSON.stringify(track)}\n`));
  const gzPath = Path.join(WORK_DIR, `${eventId}.json.gz`);
  Fs.writeFileSync(gzPath, gz);
  // Immutable once resolved → cache hard; still-active → short TTL so the
  // growing track refreshes. Stored gzipped (~5× smaller); browsers decode
  // transparently via Content-Encoding.
  const maxAge = finalized ? 86400 : 60;
  execFileSync(
    'rclone',
    [
      'copyto',
      gzPath,
      `${REMOTE}/tracks/${eventId}.json`,
      '--s3-no-check-bucket',
      '--header-upload',
      'Content-Encoding: gzip',
      '--header-upload',
      'Content-Type: application/json',
      '--header-upload',
      `Cache-Control: public, max-age=${maxAge}`,
    ],
    { stdio: 'pipe' },
  );
}

async function main() {
  const dryRun = !!argv['dry-run'];
  const now = Date.now();
  const payload = await loadAlerts();
  const incidents = payload.incidents ?? [];
  const manifest = loadManifest();
  const db = new Database(DB_PATH, { readonly: true });

  const posQuery = db.prepare(
    `SELECT ts, vehicle_id, direction AS dir, lat, lon
       FROM observations
      WHERE kind = 'train' AND route = ? AND ts BETWEEN ? AND ? AND lat IS NOT NULL
      ORDER BY ts`,
  );

  let scanned = 0;
  let uploaded = 0;
  let skippedFinal = 0;
  let skippedOld = 0;
  let skippedEmpty = 0;
  const dryOut = [];

  for (const incident of incidents) {
    if (argv.event && incident.id !== argv.event) continue;
    const picked = pickReplayableIncident(incident);
    if (!picked) continue;
    scanned++;

    if (picked.onset < now - RETENTION_MS) {
      skippedOld++;
      continue;
    }
    // Already archived after it resolved → immutable, nothing to do.
    if (manifest[picked.eventId]?.finalized) {
      skippedFinal++;
      continue;
    }

    const qstart = picked.onset - PAD_MS;
    const qend = picked.resolved != null ? picked.resolved + PAD_MS : now;
    const rows = posQuery.all(picked.lineShort, qstart, qend);
    if (rows.length === 0) {
      skippedEmpty++;
      continue;
    }

    const affectedDir = resolveAffectedDir(
      picked.directionLabel,
      destByDir(db, picked.lineShort, qstart, qend),
    );
    const track = buildTrack({ ...picked, affectedDir }, rows, now);
    if (!track) {
      skippedEmpty++;
      continue;
    }

    const finalized = picked.resolved != null;
    if (dryRun) {
      Fs.mkdirSync(WORK_DIR, { recursive: true });
      const outPath = Path.join(WORK_DIR, `${picked.eventId}.json`);
      Fs.writeFileSync(outPath, JSON.stringify(track));
      dryOut.push(
        `${picked.eventId} ${track.line} ${track.from}→${track.to} dir=${affectedDir ?? '-'} ${track.vehicles.length}veh ${track.durSec}s ${finalized ? 'final' : 'active'}`,
      );
    } else {
      uploadTrack(picked.eventId, track, finalized);
      manifest[picked.eventId] = { uploadedTs: now, resolved: picked.resolved ?? null, finalized };
    }
    uploaded++;
  }

  db.close();

  if (dryRun) {
    console.log(`[dry-run] would archive ${uploaded} tracks → ${WORK_DIR}`);
    for (const line of dryOut) console.log(`  ${line}`);
  } else if (uploaded > 0) {
    Fs.mkdirSync(Path.dirname(MANIFEST_PATH), { recursive: true });
    Fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  console.log(
    `export-event-tracks: scanned ${scanned} replayable, ${dryRun ? 'would upload' : 'uploaded'} ${uploaded}` +
      ` (skipped ${skippedFinal} final, ${skippedOld} out-of-window, ${skippedEmpty} no-positions)`,
  );
}

if (require.main === module) {
  runBin(main);
}

module.exports = { main };
