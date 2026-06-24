#!/usr/bin/env node
require('../src/shared/env');

const { setup, runBin } = require('../src/shared/runBin');
const { fetchAlerts } = require('../src/shared/ctaAlerts');
const { getMetraAlerts } = require('../src/metra/api');
const { toCtaOutageRows, toMetraOutageRows } = require('../src/shared/accessibility');
const {
  upsertAccessibilityOutages,
  reconcileAccessibilityOutages,
} = require('../src/shared/history');

const DRY_RUN = process.argv.includes('--dry-run') || process.env.ACCESSIBILITY_DRY_RUN === '1';

async function main({ now = Date.now() } = {}) {
  setup();
  const [ctaRes, metraRes] = await Promise.allSettled([fetchAlerts(), getMetraAlerts()]);
  if (ctaRes.status === 'rejected' && metraRes.status === 'rejected') throw ctaRes.reason;
  if (ctaRes.status === 'rejected') {
    console.warn(`CTA accessibility fetch failed: ${ctaRes.reason?.message}`);
  }
  if (metraRes.status === 'rejected') {
    console.warn(`Metra accessibility fetch failed: ${metraRes.reason?.message}`);
  }
  const ctaAlerts = ctaRes.status === 'fulfilled' ? ctaRes.value : [];
  const metraAlerts = metraRes.status === 'fulfilled' ? metraRes.value : [];
  const rows = [...toCtaOutageRows(ctaAlerts, now), ...toMetraOutageRows(metraAlerts, now)].filter(
    (r) => r.sourceId,
  );
  const seenIds = new Set(rows.map((r) => r.sourceId));
  console.log(
    `Fetched ${ctaAlerts.length} CTA alerts and ${metraAlerts.length} Metra alerts, ${rows.length} accessibility outages`,
  );

  if (DRY_RUN) {
    for (const row of rows) console.log(JSON.stringify(row));
    return;
  }

  upsertAccessibilityOutages(rows, now);
  if (ctaAlerts.length === 0 && metraAlerts.length === 0) {
    console.warn('CTA and Metra returned 0 alerts — skipping accessibility reconciliation');
    return;
  }
  reconcileAccessibilityOutages(seenIds, now);
}

if (require.main === module) {
  runBin(main);
}

module.exports = { main };
