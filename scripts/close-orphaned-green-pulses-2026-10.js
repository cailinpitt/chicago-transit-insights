#!/usr/bin/env node
// One-off: close three Green Line pulse-cold incidents left open forever after
// their pulse_state was evicted as a "duplicate segment" shadow (fixed in
// bin/train/pulse.js#planSegmentDedup). Each gets an unposted observed-clear at
// the bot's next clear over an overlapping stretch of the line, so the event
// page shows the real duration. No Bluesky replies — a ✅ weeks later would
// read as a new recovery. Re-run bin/push-web-data.sh afterwards.
//
//   node scripts/close-orphaned-green-pulses-2026-10.js [--dry-run]
require('../src/shared/env');
const { getDb, recordUnpostedPulseClear } = require('../src/shared/history');

const DID = 'did:plc:jgg4dtdflzzemyvnybucnzdw';
// pulse rkey → disruption_events id of the overlapping clear that ends it
const CLOSES = {
  '3mwikcy7yzz2g': 8636, // Laramie → Ashland; cleared with Cicero → Damen, 2026-09-27 23:40
  '3mwjjf7fdua2g': 8636, // Cicero → Ashland; same clear
  '3mynvjdx6e42r': 10372, // Clinton → Indiana; cleared with Clinton → Roosevelt, 2026-10-24 21:32
};

const dryRun = process.argv.includes('--dry-run');
const db = getDb();

for (const [rkey, clearId] of Object.entries(CLOSES)) {
  const pulseUri = `at://${DID}/app.bsky.feed.post/${rkey}`;
  const clear = db
    .prepare("SELECT ts, line FROM disruption_events WHERE id = ? AND source = 'observed-clear'")
    .get(clearId);
  if (!clear) throw new Error(`clear ${clearId} not found`);
  const pulse = db
    .prepare("SELECT ts, line FROM disruption_events WHERE source = 'observed' AND post_uri = ?")
    .get(pulseUri);
  if (!pulse) throw new Error(`pulse ${rkey} not found`);
  if (pulse.line !== clear.line || clear.ts < pulse.ts) {
    throw new Error(`clear ${clearId} does not follow pulse ${rkey} on the same line`);
  }
  const open = db.prepare('SELECT 1 FROM pulse_state WHERE active_post_uri = ?').get(pulseUri);
  if (open) throw new Error(`pulse ${rkey} still has live pulse_state; leave it to the bot`);

  const at = new Date(clear.ts).toLocaleString('en-US', { timeZone: 'America/Chicago' });
  const hours = ((clear.ts - pulse.ts) / 3600000).toFixed(1);
  if (dryRun) {
    console.log(`would close ${rkey} at ${at} (${hours}h)`);
    continue;
  }
  const wrote = recordUnpostedPulseClear({ kind: 'train', pulseUri }, clear.ts);
  console.log(`${wrote ? 'closed' : 'already closed'} ${rkey} at ${at} (${hours}h)`);
}
