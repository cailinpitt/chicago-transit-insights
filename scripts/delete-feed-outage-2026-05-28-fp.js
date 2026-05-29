#!/usr/bin/env node
// One-off: delete the 2026-05-28 fleet-wide feed-outage FPs from Bluesky and
// the history DB. The CTA Bus Tracker feed froze 21:06→21:44 CDT; every route
// went cold at once and bus-pulse posted 5 blackout FPs (routes 54/63/66/72/79)
// plus their ✅ resolutions. The website rebuilds alerts.json from the DB, so
// removing these rows + re-running bin/push-web-data.sh drops them from the
// site too.
//
// Companion fix: the feed-freshness guard in src/bus/pulse.js + the
// bus-feed-outage-2026-05-28-2143 regression fixture.
require('../src/shared/env');
const Database = require('better-sqlite3');
const { loginAlerts } = require('../src/shared/bluesky');

const DB = process.env.HISTORY_DB || '/home/cailin/Development/cta-insights/state/history.sqlite';
const ALERT_DID = 'did:plc:jgg4dtdflzzemyvnybucnzdw';
const ALERT_RKEYS = [
  // alert roots
  '3mmxjdmfyot2f', // 54
  '3mmxjdtk3ld2i', // 63
  '3mmxjdoaubz2m', // 66
  '3mmxjdmzflr2m', // 72
  '3mmxjdowrl22e', // 79
  // resolution replies
  '3mmxjpgbil72x', // 54
  '3mmxjphonps2e', // 63
  '3mmxjpjbdso2y', // 66
  '3mmxjpkmydz2v', // 72
  '3mmxjplwke22e', // 79
];

async function main() {
  const agent = await loginAlerts();
  const repoDid = agent.session?.did || agent.did;
  if (repoDid !== ALERT_DID) {
    throw new Error(`Logged in as ${repoDid}, expected ${ALERT_DID}`);
  }
  for (const rkey of ALERT_RKEYS) {
    try {
      await agent.com.atproto.repo.deleteRecord({
        repo: repoDid,
        collection: 'app.bsky.feed.post',
        rkey,
      });
      console.log(`deleted bluesky post ${rkey}`);
    } catch (e) {
      console.warn(`bluesky delete ${rkey} failed: ${e.message}`);
    }
  }

  // All observed / observed-clear rows for these 5 routes inside the outage
  // window (21:31:03 → 21:44:42 CDT) are FPs — includes the pre-post
  // detection rows (posted=0) and the paired clears.
  const db = new Database(DB);
  const res = db
    .prepare(
      `DELETE FROM disruption_events
       WHERE kind = 'bus'
         AND line IN ('54', '63', '66', '72', '79')
         AND source IN ('observed', 'observed-clear')
         AND ts BETWEEN 1780021863010 AND 1780022682142`,
    )
    .run();
  console.log(`disruption_events deleted: ${res.changes}`);
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
