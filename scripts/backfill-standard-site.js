#!/usr/bin/env node
// Backfill / reconcile standard.site records for the CTA/Metra archive.
//
// Ensures the publication record exists, then publishes a site.standard.document
// record for every incident that has an /event page, keyed by `incident.id` —
// the exact slug the website uses for /event/<id>, so each document's `path`
// matches its page. Idempotent (unchanged records are skipped), so it doubles
// as a periodic reconcile that enriches the minimal records the live alerts
// path creates and heals any consolidation changes.
//
// Source of incidents is the published alerts.json (the same payload the site
// builds from), so manifest keys always match what the frontend serves. Pass a
// local path or URL to override the default data origin.
//
// Records are repo writes (com.atproto.repo.putRecord), NOT Bluesky posts —
// nothing is published to a timeline.
//
// push-web-data.sh runs this every tick against the freshly-exported
// tmp/web-data/alerts.json (so the manifest it builds next is complete); it's
// also safe to run by hand for an immediate reconcile or first mint:
//
//   node scripts/backfill-standard-site.js --dry-run            # show changes
//   node scripts/backfill-standard-site.js                      # publish
//   node scripts/backfill-standard-site.js /path/to/alerts.json # local source

require('../src/shared/env');

const Fs = require('node:fs');
const { loginAlerts } = require('../src/shared/bluesky');
const { ensurePublication, ensureDocument } = require('../src/shared/standardSite');

const DRY_RUN = process.argv.includes('--dry-run');
const SOURCE =
  process.argv.slice(2).find((a) => !a.startsWith('--')) ||
  `${(process.env.DATA_ORIGIN_URL || 'https://data.chicagotransitalerts.app').replace(/\/$/, '')}/alerts.json`;

// An incident has an /event page only when it carries a Bluesky post (the page
// slug is the post rkey). Postless incidents (e.g. instantly-resolved metra
// notices) get no page, so they get no document record.
function hasEventPage(incident) {
  if (incident.official_alert?.post_url) return true;
  return (incident.detections || []).some((d) => d?.post_url);
}

// Best-effort document title/description. Path-match (not title) drives
// standard.site verification, so this only needs to be sensible and neutral.
function documentFields(incident) {
  const official = incident.official_alert;
  const detection = (incident.detections || [])[0];
  const routes = (incident.routes || []).join(', ');
  const mode = incident.mode || 'transit';
  const title =
    official?.headline ||
    detection?.headline ||
    (routes ? `${routes} ${mode} service disruption` : `CTA ${mode} service disruption`);
  const description = official?.description || detection?.summary || undefined;
  const life = incident.lifecycle || {};
  const publishedAt = life.onset_ts ?? life.first_seen_ts ?? Date.now();
  const updatedAt = life.resolved_ts ?? undefined;
  return { rkey: incident.id, title, description, publishedAt, updatedAt };
}

async function loadIncidents() {
  let text;
  if (Fs.existsSync(SOURCE)) {
    text = Fs.readFileSync(SOURCE, 'utf8');
  } else {
    const res = await fetch(SOURCE, { cache: 'no-store' });
    if (!res.ok) throw new Error(`fetch ${SOURCE}: HTTP ${res.status}`);
    text = await res.text();
  }
  const payload = JSON.parse(text);
  const incidents = payload.incidents || payload;
  return incidents.filter((inc) => inc.id && hasEventPage(inc));
}

async function main() {
  const incidents = await loadIncidents();
  console.log(`backfill-standard-site: ${incidents.length} incidents with pages (${SOURCE})`);

  if (DRY_RUN) {
    for (const inc of incidents.slice(0, 10)) {
      const f = documentFields(inc);
      console.log(`  would publish doc /event/${f.rkey} — "${f.title}"`);
    }
    if (incidents.length > 10) console.log(`  …and ${incidents.length - 10} more`);
    console.log('--- DRY RUN: 1 publication + N documents would be put (no network writes) ---');
    return;
  }

  const agent = await loginAlerts();
  const pub = await ensurePublication(agent);
  console.log(`publication: ${pub.uri}`);

  let created = 0;
  let failed = 0;
  for (const inc of incidents) {
    try {
      await ensureDocument(agent, documentFields(inc));
      created += 1;
    } catch (e) {
      failed += 1;
      console.warn(`  doc /event/${inc.id} failed: ${e.message}`);
    }
  }
  console.log(`backfill-standard-site: ensured ${created} documents (${failed} failed)`);
  console.log('Next: run bin/export-standard-site.js (or push-web-data.sh) to publish.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
